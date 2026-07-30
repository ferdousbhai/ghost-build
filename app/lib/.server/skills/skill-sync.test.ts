import { describe, expect, it, vi } from 'vitest';
import { activateCloudflareSkillUpdates, inspectCloudflareSkillUpdates } from './skill-sync';
import { upstreamCloudflareSkills } from './skill-sources';

const treeSha = 'a'.repeat(40);
const originalBlobSha = 'b'.repeat(40);
const changedBlobSha = 'c'.repeat(40);

describe('Cloudflare skill synchronization', () => {
  it('stops after the tree metadata request when the upstream tree is unchanged', async () => {
    const prepare = vi.fn(() => ({
      bind: () => ({
        first: async () => ({ upstream_tree_sha: treeSha }),
      }),
    }));
    const fetcher = vi.fn(async () =>
      Response.json({
        sha: treeSha,
        truncated: false,
        tree: [],
      }),
    );

    const result = await inspectCloudflareSkillUpdates(
      { DB: { prepare } as unknown as D1Database },
      fetcher as typeof fetch,
    );

    expect(result).toEqual({ status: 'unchanged', treeSha });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('compares metadata and identifies only changed skill blobs', async () => {
    const storedRows = upstreamCloudflareSkills.map((skill) => ({
      doc_key: skill.docKey,
      upstream_path: skill.path,
      upstream_blob_sha: originalBlobSha,
      content_sha256: 'd'.repeat(64),
      storage_key: `system/skills/blobs/${'d'.repeat(64)}.md`,
    }));
    const prepare = vi.fn((sql: string) => ({
      bind: () => ({
        first: async () => (sql.includes('skill_sync_state') ? { upstream_tree_sha: 'e'.repeat(40) } : null),
        all: async () => ({ results: storedRows }),
      }),
    }));
    const fetcher = vi.fn(async () =>
      Response.json({
        sha: treeSha,
        truncated: false,
        tree: upstreamCloudflareSkills.map((skill, index) => ({
          path: skill.path,
          type: 'blob',
          sha: index === 0 ? changedBlobSha : originalBlobSha,
          size: 1_024,
          url: `https://api.github.com/blob/${skill.name}`,
        })),
      }),
    );

    const result = await inspectCloudflareSkillUpdates(
      { DB: { prepare } as unknown as D1Database },
      fetcher as typeof fetch,
    );

    expect(result.status).toBe('changed');
    if (result.status === 'changed') {
      expect(result.changed).toEqual([
        expect.objectContaining({
          docKey: 'cloudflarePlatform',
          blobSha: changedBlobSha,
        }),
      ]);
    }
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('downloads only changed content and publishes an immutable release plus active manifest', async () => {
    const content = `---
name: cloudflare
description: Current Cloudflare platform guidance.
---

# Cloudflare

Current guidance.
`;
    const stored = upstreamCloudflareSkills.slice(1).map((skill) => ({
      docKey: skill.docKey,
      upstreamPath: skill.path,
      upstreamBlobSha: originalBlobSha,
      contentSha256: 'd'.repeat(64),
      storageKey: `system/skills/blobs/${'d'.repeat(64)}.md`,
    }));
    const changed = {
      docKey: 'cloudflarePlatform' as const,
      name: 'cloudflare',
      path: 'skills/cloudflare/SKILL.md',
      blobSha: changedBlobSha,
      size: new TextEncoder().encode(content).byteLength,
    };
    const put = vi.fn(async (_key: string, _value: unknown) => ({}));
    const batch = vi.fn(async () => []);
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({})),
    }));
    const fetcher = vi.fn(async () =>
      Response.json({
        sha: changedBlobSha,
        encoding: 'base64',
        content: btoa(content),
        size: changed.size,
      }),
    );

    const result = await activateCloudflareSkillUpdates(
      {
        APP_STORAGE: { put } as unknown as R2Bucket,
        DB: { batch, prepare } as unknown as D1Database,
      },
      { status: 'changed', treeSha, changed: [changed], stored },
      fetcher as typeof fetch,
      123,
    );

    expect(result).toEqual({ changed: 1, releaseSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls.map(([key]) => key)).toEqual([
      expect.stringMatching(/^system\/skills\/blobs\/[0-9a-f]{64}\.md$/),
      expect.stringMatching(/^system\/skills\/releases\/[0-9a-f]{64}\.json$/),
      'system/skills/active.json',
    ]);
    expect(batch).toHaveBeenCalledOnce();
  });
});
