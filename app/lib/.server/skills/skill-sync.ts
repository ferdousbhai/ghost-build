import { z } from 'zod';
import { activeSkillManifestSchema, type ActiveSkillManifest } from './skill-manifest';
import { sha256Hex, validateUpstreamSkillContent } from './skill-content';
import {
  ACTIVE_SKILL_MANIFEST_KEY,
  CLOUDFLARE_SKILL_SOURCE,
  SKILL_BLOB_PREFIX,
  SKILL_RELEASE_PREFIX,
  upstreamCloudflareSkills,
  type UpstreamCloudflareDocKey,
} from './skill-sources';

const githubSha = z.string().regex(/^[0-9a-f]{40}$/);
const gitTreeSchema = z.object({
  sha: githubSha,
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      sha: githubSha,
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});
const gitBlobSchema = z.object({
  sha: githubSha,
  encoding: z.literal('base64'),
  content: z.string(),
  size: z.number().int().nonnegative(),
});

type StoredSkillEntry = {
  docKey: UpstreamCloudflareDocKey;
  upstreamPath: string;
  upstreamBlobSha: string;
  contentSha256: string;
  storageKey: string;
};

type SkillSyncInspection =
  | {
      status: 'unchanged';
      treeSha: string;
    }
  | {
      status: 'changed';
      treeSha: string;
      changed: Array<{
        docKey: UpstreamCloudflareDocKey;
        name: string;
        path: string;
        blobSha: string;
        size: number;
      }>;
      stored: StoredSkillEntry[];
    };

const githubHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'ghostbuild-skill-sync',
  'X-GitHub-Api-Version': '2026-03-10',
};

export async function inspectCloudflareSkillUpdates(
  env: Pick<Env, 'DB'>,
  fetcher: typeof fetch = fetch,
): Promise<SkillSyncInspection> {
  const [state, treeResponse] = await Promise.all([
    env.DB.prepare('SELECT upstream_tree_sha FROM skill_sync_state WHERE source_id = ?')
      .bind(CLOUDFLARE_SKILL_SOURCE.id)
      .first<{ upstream_tree_sha: string | null }>(),
    fetcher(
      `https://api.github.com/repos/${CLOUDFLARE_SKILL_SOURCE.repository}/git/trees/${CLOUDFLARE_SKILL_SOURCE.branch}?recursive=1`,
      { headers: githubHeaders },
    ),
  ]);
  const tree = gitTreeSchema.parse(await githubJson(treeResponse, 'skill tree'));
  if (tree.truncated) {
    throw new Error('The upstream Cloudflare skill tree was truncated.');
  }
  if (state?.upstream_tree_sha === tree.sha) {
    return { status: 'unchanged', treeSha: tree.sha };
  }

  const storedRows = await env.DB.prepare(
    `SELECT doc_key, upstream_path, upstream_blob_sha, content_sha256, storage_key
     FROM skill_sync_entries
     WHERE source_id = ?`,
  )
    .bind(CLOUDFLARE_SKILL_SOURCE.id)
    .all<{
      doc_key: string;
      upstream_path: string;
      upstream_blob_sha: string;
      content_sha256: string;
      storage_key: string;
    }>();
  const stored = storedRows.results
    .filter((row): row is typeof row & { doc_key: UpstreamCloudflareDocKey } =>
      upstreamCloudflareSkills.some((skill) => skill.docKey === row.doc_key),
    )
    .map((row) => ({
      docKey: row.doc_key,
      upstreamPath: row.upstream_path,
      upstreamBlobSha: row.upstream_blob_sha,
      contentSha256: row.content_sha256,
      storageKey: row.storage_key,
    }));
  const storedByDoc = new Map(stored.map((entry) => [entry.docKey, entry]));
  const treeByPath = new Map(tree.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry]));
  const changed = upstreamCloudflareSkills
    .map((skill) => {
      const upstream = treeByPath.get(skill.path);
      if (!upstream || upstream.size === undefined || upstream.size > 256 * 1024) {
        throw new Error(`Upstream skill ${skill.name} is missing or oversized.`);
      }
      return {
        docKey: skill.docKey,
        name: skill.name,
        path: skill.path,
        blobSha: upstream.sha,
        size: upstream.size,
      };
    })
    .filter((upstream) => storedByDoc.get(upstream.docKey)?.upstreamBlobSha !== upstream.blobSha);

  return { status: 'changed', treeSha: tree.sha, changed, stored };
}

export async function recordUnchangedSkillSync(env: Pick<Env, 'DB'>, treeSha: string, now = Date.now()) {
  await env.DB.prepare(
    `UPDATE skill_sync_state
     SET upstream_tree_sha = ?, status = 'current', last_checked_at = ?, last_error = NULL, updated_at = ?
     WHERE source_id = ?`,
  )
    .bind(treeSha, now, now, CLOUDFLARE_SKILL_SOURCE.id)
    .run();
}

export async function activateCloudflareSkillUpdates(
  env: Pick<Env, 'APP_STORAGE' | 'DB'>,
  inspection: Extract<SkillSyncInspection, { status: 'changed' }>,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ changed: number; releaseSha256?: string }> {
  if (inspection.changed.length === 0) {
    await recordUnchangedSkillSync(env, inspection.treeSha, now);
    return { changed: 0 };
  }

  const downloaded: StoredSkillEntry[] = [];
  for (let offset = 0; offset < inspection.changed.length; offset += 4) {
    downloaded.push(
      ...(await Promise.all(
        inspection.changed.slice(offset, offset + 4).map(async (skill): Promise<StoredSkillEntry> => {
          const response = await fetcher(
            `https://api.github.com/repos/${CLOUDFLARE_SKILL_SOURCE.repository}/git/blobs/${skill.blobSha}`,
            { headers: githubHeaders },
          );
          const blob = gitBlobSchema.parse(await githubJson(response, `skill blob ${skill.name}`));
          if (blob.sha !== skill.blobSha || blob.size !== skill.size) {
            throw new Error(`Upstream skill ${skill.name} changed during synchronization.`);
          }
          const content = decodeBase64(blob.content, skill.name);
          const bytes = validateUpstreamSkillContent(content, skill.name);
          const contentSha256 = await sha256Hex(bytes);
          const storageKey = `${SKILL_BLOB_PREFIX}${contentSha256}.md`;
          await env.APP_STORAGE.put(storageKey, bytes, {
            httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
            customMetadata: {
              source: CLOUDFLARE_SKILL_SOURCE.repository,
              upstreamBlobSha: skill.blobSha,
              contentSha256,
            },
          });
          return {
            docKey: skill.docKey,
            upstreamPath: skill.path,
            upstreamBlobSha: skill.blobSha,
            contentSha256,
            storageKey,
          };
        }),
      )),
    );
  }

  const entries = new Map(inspection.stored.map((entry) => [entry.docKey, entry]));
  for (const entry of downloaded) {
    entries.set(entry.docKey, entry);
  }
  if (entries.size !== upstreamCloudflareSkills.length) {
    throw new Error('The synchronized Cloudflare skill release is incomplete.');
  }

  const manifest = activeSkillManifestSchema.parse({
    schemaVersion: 1,
    source: {
      id: CLOUDFLARE_SKILL_SOURCE.id,
      repository: CLOUDFLARE_SKILL_SOURCE.repository,
      treeSha: inspection.treeSha,
    },
    activatedAt: now,
    skills: Object.fromEntries(
      upstreamCloudflareSkills.map(({ docKey }) => {
        const entry = entries.get(docKey);
        if (!entry) {
          throw new Error(`The synchronized Cloudflare skill release is missing ${docKey}.`);
        }
        return [
          docKey,
          {
            storageKey: entry.storageKey,
            contentSha256: entry.contentSha256,
            upstreamBlobSha: entry.upstreamBlobSha,
          },
        ];
      }),
    ),
  }) satisfies ActiveSkillManifest;
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const releaseSha256 = await sha256Hex(manifestBytes);
  const objectOptions: R2PutOptions = {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { releaseSha256 },
  };
  await env.APP_STORAGE.put(`${SKILL_RELEASE_PREFIX}${releaseSha256}.json`, manifestBytes, objectOptions);
  await env.APP_STORAGE.put(ACTIVE_SKILL_MANIFEST_KEY, manifestBytes, objectOptions);

  const statements = downloaded.map((entry) =>
    env.DB.prepare(
      `INSERT INTO skill_sync_entries (
         source_id, doc_key, upstream_path, upstream_blob_sha, content_sha256, storage_key, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, doc_key) DO UPDATE SET
         upstream_path = excluded.upstream_path,
         upstream_blob_sha = excluded.upstream_blob_sha,
         content_sha256 = excluded.content_sha256,
         storage_key = excluded.storage_key,
         updated_at = excluded.updated_at`,
    ).bind(
      CLOUDFLARE_SKILL_SOURCE.id,
      entry.docKey,
      entry.upstreamPath,
      entry.upstreamBlobSha,
      entry.contentSha256,
      entry.storageKey,
      now,
    ),
  );
  statements.push(
    env.DB.prepare(
      `UPDATE skill_sync_state
       SET upstream_tree_sha = ?,
           previous_release_sha256 = active_release_sha256,
           active_release_sha256 = ?,
           status = 'current',
           last_checked_at = ?,
           last_changed_at = ?,
           last_error = NULL,
           updated_at = ?
       WHERE source_id = ?`,
    ).bind(inspection.treeSha, releaseSha256, now, now, now, CLOUDFLARE_SKILL_SOURCE.id),
  );
  await env.DB.batch(statements);
  return { changed: downloaded.length, releaseSha256 };
}

export async function recordSkillSyncFailure(env: Pick<Env, 'DB'>, error: unknown, now = Date.now()): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  await env.DB.prepare(
    `UPDATE skill_sync_state
     SET status = 'failed', last_checked_at = ?, last_error = ?, updated_at = ?
     WHERE source_id = ?`,
  )
    .bind(now, message, now, CLOUDFLARE_SKILL_SOURCE.id)
    .run();
}

async function githubJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} while reading the upstream ${label}.`);
  }
  return response.json();
}

function decodeBase64(value: string, skillName: string): string {
  try {
    const normalized = value.replace(/\s+/g, '');
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Upstream skill ${skillName} is not valid base64 UTF-8 content.`);
  }
}
