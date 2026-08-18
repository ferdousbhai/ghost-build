import { parse } from 'yaml';
import { BUILDER_SKILLS_POINTER_KEY } from '~/lib/.server/llm/builder-skills';
import { BUILDER_SKILL_SOURCES, type SkillSource } from './upstream-sources';
const GITHUB_API = 'https://api.github.com';
const MAX_GITHUB_ERROR_BYTES = 4 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_POINTER_BYTES = 64 * 1024;
// A changed generation can require one upstream read and one R2 write per file in the same cron invocation.
const MAX_FILES = 400;
const MAX_SKILLS = 64;
const MAX_DISCOVERED_SKILLS = 24;
const MAX_R2_KEY_BYTES = 1024;
const MAX_BUILDER_SKILL_PROMPT_CHARS = 16_000;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TEXT_EXTENSIONS = new Set([
  '.bash',
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export type SourceRevision = {
  id: string;
  repository: string;
  revision: string;
};
type SkillFile = {
  name: string;
  path: string;
  content: Uint8Array;
  contentType: string;
  sha256: string;
  size: number;
};
type PublishedPointer = {
  version: 1;
  generation: string;
  skills: string[];
};
type PublishedPointerSnapshot = {
  pointer: PublishedPointer | null;
  etag: string | null;
  exists: boolean;
};
export type PackedBuilderSkills = {
  generation: string;
  files: SkillFile[];
  pointer: PublishedPointer;
  pointerSerialized: string;
  manifestSerialized: string;
};

type GitTreeEntry = {
  path: string;
  sha: string;
  type: string;
  mode: string;
  size?: number;
};
type BuilderSkillFile = {
  name: string;
  path: string;
  sha256: string;
  size: number;
};
type SkillMetadata = { name: string; description: string };
type SkillPlan = {
  source: SkillSource;
  revision: string;
  skillPath: string;
  entries: GitTreeEntry[];
};

export async function sourceConfigurationFingerprint(): Promise<string> {
  return sha256(new TextEncoder().encode(JSON.stringify(BUILDER_SKILL_SOURCES)));
}

export async function resolveSourceRevisions(request: typeof fetch = fetch): Promise<SourceRevision[]> {
  return Promise.all(
    BUILDER_SKILL_SOURCES.map(async (source) => {
      const value = await fetchBoundedJson<{
        sha?: unknown;
        commit?: { verification?: { verified?: unknown } };
      }>(request, `${GITHUB_API}/repos/${source.repository}/commits/${source.defaultBranch}`);
      if (
        typeof value.sha !== 'string' ||
        !REVISION_PATTERN.test(value.sha) ||
        value.commit?.verification?.verified !== true
      ) {
        throw new Error(`GitHub returned an unsigned or invalid revision for ${source.repository}.`);
      }
      return {
        id: source.id,
        repository: source.repository,
        revision: value.sha,
      };
    }),
  );
}

export async function hasSignificantSkillChanges(
  published: ReadonlyMap<string, string>,
  observed: readonly SourceRevision[],
  request: typeof fetch = fetch,
): Promise<boolean> {
  if (!sameSourceInventory(observed)) {
    throw new Error('Builder skill source revisions are incomplete.');
  }
  for (const source of BUILDER_SKILL_SOURCES) {
    const previousRevision = published.get(source.id);
    const nextRevision = observed.find(({ id }) => id === source.id)!.revision;
    if (!previousRevision || !REVISION_PATTERN.test(previousRevision)) {
      throw new Error(`Published builder skill revision is invalid: ${source.id}`);
    }
    if (previousRevision === nextRevision) {
      continue;
    }
    const [previousTree, nextTree] = await Promise.all([
      fetchTree(request, source, previousRevision),
      fetchTree(request, source, nextRevision),
    ]);
    if (
      selectedTreeFingerprint(previousTree, candidateSkillPaths(source, previousTree)) !==
      selectedTreeFingerprint(nextTree, candidateSkillPaths(source, nextTree))
    ) {
      return true;
    }
  }
  return false;
}

export async function buildBuilderSkillGeneration(
  revisions: readonly SourceRevision[],
  request: typeof fetch = fetch,
): Promise<PackedBuilderSkills> {
  if (!sameSourceInventory(revisions)) {
    throw new Error('Builder skill source revisions are incomplete.');
  }

  const plans: SkillPlan[] = [];
  for (const source of BUILDER_SKILL_SOURCES) {
    const revision = revisions.find(({ id }) => id === source.id)!.revision;
    const tree = await fetchTree(request, source, revision);
    const skillPaths = await selectedSkillPaths(source, tree, revision, request);
    for (const skillPath of skillPaths) {
      const entries = tree
        .filter(({ path }) => path.startsWith(`${skillPath}/`))
        .toSorted((left, right) => left.path.localeCompare(right.path));
      if (!entries.some(({ path }) => path === `${skillPath}/SKILL.md`)) {
        throw new Error(`Upstream skill is missing SKILL.md: ${source.repository}/${skillPath}`);
      }
      plans.push({ source, revision, skillPath, entries });
    }
  }
  preflightPlans(plans);

  const files: SkillFile[] = [];
  const metadataByName = new Map<string, SkillMetadata>();
  for (const plan of plans) {
    const entrypoint = plan.entries.find(({ path }) => path === `${plan.skillPath}/SKILL.md`)!;
    const entrypointContent = await readFile(request, plan.source.repository, plan.revision, entrypoint);
    const metadata = parseSkillMetadata(entrypointContent, `${plan.source.repository}/${plan.skillPath}/SKILL.md`);
    if (metadataByName.has(metadata.name)) {
      throw new Error(`Upstream builder skills contain a duplicate name: ${metadata.name}`);
    }
    metadataByName.set(metadata.name, metadata);

    for (const entry of plan.entries) {
      const path = entry.path.slice(plan.skillPath.length + 1);
      const key = `generations/${'0'.repeat(64)}/skills/${metadata.name}/${path}`;
      if (new TextEncoder().encode(key).byteLength > MAX_R2_KEY_BYTES) {
        throw new Error(`Upstream builder skill path exceeds the R2 key limit: ${metadata.name}/${path}`);
      }
    }
    const loaded = await mapLimit(plan.entries, 8, async (entry) => ({
      entry,
      content:
        entry === entrypoint
          ? entrypointContent
          : await readFile(request, plan.source.repository, plan.revision, entry),
    }));
    for (const { entry, content } of loaded) {
      const path = entry.path.slice(plan.skillPath.length + 1);
      validateRuntimeText(content, path, plan.source.repository);
      files.push({
        name: metadata.name,
        path,
        content,
        contentType: contentType(path),
        sha256: await sha256(content),
        size: content.byteLength,
      });
    }
  }
  validateCatalog(metadataByName);

  files.sort((left, right) => `${left.name}/${left.path}`.localeCompare(`${right.name}/${right.path}`));
  const manifestFiles = files.map(({ name, path, sha256: digest, size }) => ({
    name,
    path,
    sha256: digest,
    size,
  }));
  const generation = await sha256(new TextEncoder().encode(generationInput(manifestFiles)));
  const pointer: PublishedPointer = {
    version: 1,
    generation,
    skills: [...metadataByName.keys()].toSorted(),
  };
  const pointerSerialized = JSON.stringify(pointer);
  const manifestSerialized = JSON.stringify({
    version: 1,
    generation,
    files: manifestFiles,
  });
  if (new TextEncoder().encode(manifestSerialized).byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("Builder skill generation manifest exceeds Ghostbuild's read limit.");
  }
  return {
    generation,
    files,
    pointer,
    pointerSerialized,
    manifestSerialized,
  };
}

export async function readPublishedPointerSnapshot(bucket: R2Bucket): Promise<PublishedPointerSnapshot> {
  const object = await bucket.get(BUILDER_SKILLS_POINTER_KEY);
  if (!object) {
    return { pointer: null, etag: null, exists: false };
  }
  if (object.size > MAX_POINTER_BYTES) {
    return { pointer: null, etag: object.etag, exists: true };
  }
  let value: unknown;
  try {
    value = JSON.parse(await object.text());
  } catch {
    return { pointer: null, etag: object.etag, exists: true };
  }
  return {
    pointer: parsePointer(value),
    etag: object.etag,
    exists: true,
  };
}

export async function validatePublishedGeneration(bucket: R2Bucket, pointer: PublishedPointer): Promise<boolean> {
  try {
    const prefix = `generations/${pointer.generation}`;
    const manifestObject = await bucket.get(`${prefix}/manifest.json`);
    if (!manifestObject || manifestObject.size > MAX_MANIFEST_BYTES) {
      return false;
    }
    const manifest = parseManifest(JSON.parse(await manifestObject.text()), pointer);
    if ((await sha256(new TextEncoder().encode(generationInput(manifest)))) !== pointer.generation) {
      return false;
    }
    const expected = new Map(manifest.map((file) => [`${prefix}/skills/${file.name}/${file.path}`, file]));
    const listedObjects: R2Object[] = [];
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix: `${prefix}/skills/`, cursor });
      listedObjects.push(...listed.objects);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    if (listedObjects.length !== expected.size) {
      return false;
    }
    return listedObjects.every((object) => {
      const file = expected.get(object.key);
      return file !== undefined && object.size === file.size && checksumHex(object.checksums.sha256) === file.sha256;
    });
  } catch {
    return false;
  }
}

export async function publishBuilderSkillGeneration(
  bucket: R2Bucket,
  packed: PackedBuilderSkills,
  expectedPointer: Pick<PublishedPointerSnapshot, 'etag' | 'exists'>,
): Promise<void> {
  const prefix = `generations/${packed.generation}`;
  const manifestKey = `${prefix}/manifest.json`;

  const expectedFileKeys = new Set(packed.files.map(({ name, path }) => `${prefix}/skills/${name}/${path}`));
  const unexpectedKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: `${prefix}/skills/`, cursor });
    unexpectedKeys.push(...listed.objects.map(({ key }) => key).filter((key) => !expectedFileKeys.has(key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  if (unexpectedKeys.length > 0) {
    await bucket.delete(unexpectedKeys);
  }

  await mapLimit(packed.files, 8, async (file) => {
    const key = `${prefix}/skills/${file.name}/${file.path}`;
    await bucket.put(key, file.content, {
      httpMetadata: { contentType: file.contentType },
      sha256: hexBytes(file.sha256),
    });
  });

  const existingManifest = await bucket.get(manifestKey);
  const manifest = await bucket.put(manifestKey, packed.manifestSerialized, {
    onlyIf: existingManifest ? { etagMatches: existingManifest.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
    sha256: hexBytes(await sha256(new TextEncoder().encode(packed.manifestSerialized))),
  });
  if (!manifest) {
    throw new Error('Builder skill generation changed while publishing its manifest.');
  }
  if (!(await validatePublishedGeneration(bucket, packed.pointer))) {
    throw new Error('Builder skill generation failed its publication readback.');
  }

  const pointer = await bucket.put(BUILDER_SKILLS_POINTER_KEY, packed.pointerSerialized, {
    onlyIf: expectedPointer.exists ? { etagMatches: expectedPointer.etag! } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
    sha256: hexBytes(await sha256(new TextEncoder().encode(packed.pointerSerialized))),
  });
  if (!pointer) {
    throw new Error('Builder skill pointer changed during publication.');
  }
  const readback = await readPublishedPointerSnapshot(bucket);
  if (
    readback.pointer?.generation !== packed.generation ||
    !(await validatePublishedGeneration(bucket, packed.pointer))
  ) {
    throw new Error('Published builder skill generation failed its readback.');
  }
}

export async function selectedSkillPaths(
  source: SkillSource,
  tree: readonly GitTreeEntry[],
  revision: string,
  request: typeof fetch = fetch,
): Promise<string[]> {
  const entrypoints = new Map(
    tree
      .filter(({ path }) => path.endsWith('/SKILL.md'))
      .map((entry) => [entry.path.slice(0, -'/SKILL.md'.length), entry]),
  );
  const selected = new Set(source.skills.filter((skillPath) => entrypoints.has(skillPath)));
  if (source.discovery) {
    const discovered = discoverSkillPaths(tree, source.discovery.root, source.discovery.entrypoint);
    if (discovered.length > MAX_DISCOVERED_SKILLS) {
      throw new Error('Upstream builder skill discovery exceeds its inventory limit.');
    }
    const excludedNames = new Set(source.discovery.excludedSkillNames);
    for (const skillPath of discovered) {
      if (selected.has(skillPath)) {
        continue;
      }
      const entrypoint = entrypoints.get(skillPath);
      if (!entrypoint) {
        continue;
      }
      const metadata = parseSkillMetadata(
        await readFile(request, source.repository, revision, entrypoint),
        `${source.repository}/${skillPath}/SKILL.md`,
      );
      if (!excludedNames.has(metadata.name)) {
        selected.add(skillPath);
      }
    }
  }
  return [...selected].toSorted();
}

function candidateSkillPaths(source: SkillSource, tree: readonly GitTreeEntry[]): string[] {
  return [
    ...new Set([
      ...source.skills,
      ...(source.discovery ? discoverSkillPaths(tree, source.discovery.root, source.discovery.entrypoint) : []),
    ]),
  ].toSorted();
}

export function discoverSkillPaths(
  tree: readonly Pick<GitTreeEntry, 'path'>[],
  root: string,
  entrypoint: string,
): string[] {
  const suffix = `/${entrypoint}`;
  return tree
    .map(({ path }) => path)
    .filter((path) => path.startsWith(`${root}/`) && path.endsWith(suffix))
    .map((path) => path.slice(0, -suffix.length))
    .filter((path) => !path.slice(root.length + 1).includes('/'))
    .toSorted();
}

function preflightPlans(plans: readonly SkillPlan[]): void {
  if (plans.length === 0 || plans.length > MAX_SKILLS) {
    throw new Error('Upstream builder skill inventory is invalid.');
  }
  const entries = plans.flatMap(({ entries }) => entries);
  if (entries.length > MAX_FILES) {
    throw new Error('Upstream builder skills contain too many files.');
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.size === undefined || entry.size <= 0 || entry.size > MAX_FILE_BYTES) {
      throw new Error(`Upstream builder skill file size is invalid: ${entry.path}`);
    }
    totalBytes += entry.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Upstream builder skills exceed their aggregate publication limit.');
    }
  }
}

function selectedTreeFingerprint(tree: readonly GitTreeEntry[], skillPaths: readonly string[]): string {
  return tree
    .filter(({ path }) => skillPaths.some((root) => path.startsWith(`${root}/`)))
    .map(({ path, sha, size, mode }) => `${path}\0${sha}\0${size ?? ''}\0${mode}`)
    .toSorted()
    .join('\n');
}

async function mapLimit<T, R>(values: readonly T[], limit: number, action: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) {
          return;
        }
        results[index] = await action(values[index]!);
      }
    }),
  );
  return results;
}

function sameSourceInventory(revisions: readonly SourceRevision[]): boolean {
  return (
    revisions.length === BUILDER_SKILL_SOURCES.length &&
    new Set(revisions.map(({ id }) => id)).size === revisions.length &&
    BUILDER_SKILL_SOURCES.every((source) => {
      const revision = revisions.find(({ id }) => id === source.id);
      return revision?.repository === source.repository && REVISION_PATTERN.test(revision.revision);
    })
  );
}

async function fetchTree(request: typeof fetch, source: SkillSource, revision: string): Promise<GitTreeEntry[]> {
  const value = await fetchBoundedJson<{ truncated?: unknown; tree?: unknown }>(
    request,
    `${GITHUB_API}/repos/${source.repository}/git/trees/${revision}?recursive=1`,
  );
  if (value.truncated === true || !Array.isArray(value.tree)) {
    throw new Error(`GitHub returned an incomplete tree for ${source.repository}.`);
  }
  const entries = value.tree.map(parseTreeEntry);
  const paths = entries.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) {
    throw new Error(`GitHub returned duplicate tree paths for ${source.repository}.`);
  }
  const candidateRoots = candidateSkillPaths(source, entries);
  if (
    entries.some(
      ({ path, type, mode }) =>
        candidateRoots.some((root) => path.startsWith(`${root}/`)) &&
        type !== 'tree' &&
        (type !== 'blob' || (mode !== '100644' && mode !== '100755')),
    )
  ) {
    throw new Error(`Candidate builder skill tree contains a non-regular file: ${source.repository}`);
  }
  return entries.filter(({ type }) => type === 'blob');
}

function parseTreeEntry(value: unknown): GitTreeEntry {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    !validRelativePath(value.path) ||
    typeof value.sha !== 'string' ||
    !REVISION_PATTERN.test(value.sha) ||
    typeof value.type !== 'string' ||
    typeof value.mode !== 'string'
  ) {
    throw new Error('GitHub returned an invalid builder skill tree entry.');
  }
  if (
    value.size !== undefined &&
    (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0)
  ) {
    throw new Error('GitHub returned an invalid builder skill file size.');
  }
  return {
    path: value.path,
    sha: value.sha,
    type: value.type,
    mode: value.mode,
    ...(typeof value.size === 'number' ? { size: value.size } : {}),
  };
}

/**
 * Upstream content is fetched from an exact revision, so a redirect means the request
 * did not land where it was aimed and its body must not be trusted.
 *
 * The Workers runtime implements no `'error'` redirect mode — it rejects the request
 * outright rather than refusing the redirect — so this asks for the redirect unfollowed
 * and checks the status instead. Every daily sync failed on that until it was corrected.
 */
const REFUSE_REDIRECTS = 'manual' as const;

function assertNotRedirected(response: Response, target: string): void {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Upstream builder skill request was redirected (${response.status}): ${target}`);
  }
}

async function readFile(
  request: typeof fetch,
  repository: string,
  revision: string,
  entry: GitTreeEntry,
): Promise<Uint8Array> {
  if (entry.size === undefined || entry.size <= 0 || entry.size > MAX_FILE_BYTES) {
    throw new Error(`Upstream builder skill file is empty or too large: ${repository}/${entry.path}`);
  }
  const encodedPath = entry.path.split('/').map(encodeURIComponent).join('/');
  const response = await request(`https://raw.githubusercontent.com/${repository}/${revision}/${encodedPath}`, {
    redirect: REFUSE_REDIRECTS,
    signal: AbortSignal.timeout(30_000),
  });
  assertNotRedirected(response, `${repository}/${entry.path}`);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Upstream builder skill file request failed (${response.status}): ${repository}/${entry.path}`);
  }
  const bytes = await readBoundedBody(response, MAX_FILE_BYTES);
  if (bytes.byteLength !== entry.size || (await gitBlobSha(bytes)) !== entry.sha) {
    throw new Error(`Upstream builder skill file is incomplete or failed integrity: ${repository}/${entry.path}`);
  }
  return bytes;
}

/** GitHub's own explanation for a refusal, bounded and stripped of formatting. */
async function readErrorSummary(response: Response): Promise<string> {
  try {
    const bytes = await readBoundedBody(response, MAX_GITHUB_ERROR_BYTES);
    const body = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const message = (JSON.parse(body) as { message?: unknown }).message;
    return typeof message === 'string' && message.length > 0 ? message : body.replace(/\s+/g, ' ').trim();
  } catch {
    return 'no explanation was returned';
  }
}

async function fetchBoundedJson<T>(request: typeof fetch, url: string): Promise<T> {
  const response = await request(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'ghostbuild-skill-sync',
      'x-github-api-version': '2022-11-28',
    },
    redirect: REFUSE_REDIRECTS,
    signal: AbortSignal.timeout(30_000),
  });
  assertNotRedirected(response, url);
  if (!response.ok) {
    // GitHub explains a refusal in the body — a rate limit and a missing repository are
    // both 403 or 404 and need different action, so discarding it leaves the daily
    // receipt saying only that something went wrong.
    throw new Error(`GitHub builder skill request failed (${response.status}): ${await readErrorSummary(response)}`);
  }
  const bytes = await readBoundedBody(response, MAX_GITHUB_RESPONSE_BYTES);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new Error('GitHub returned invalid builder skill JSON.');
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Upstream response exceeded its size limit.');
    }
  }
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Upstream response exceeded its size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseSkillMetadata(content: Uint8Array, path: string): SkillMetadata {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error(`Upstream builder skill entrypoint is not UTF-8: ${path}`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  let frontmatter: unknown;
  try {
    frontmatter = match ? parse(match[1]) : null;
  } catch {
    frontmatter = null;
  }
  if (
    !isRecord(frontmatter) ||
    typeof frontmatter.name !== 'string' ||
    !SKILL_NAME_PATTERN.test(frontmatter.name) ||
    typeof frontmatter.description !== 'string' ||
    frontmatter.description.trim().length === 0
  ) {
    throw new Error(`Upstream builder skill has invalid frontmatter: ${path}`);
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description.trim(),
  };
}

function validateCatalog(metadataByName: ReadonlyMap<string, SkillMetadata>): void {
  const prompt = [
    '<builder_skills>',
    'Before implementation, use read to load the SKILL.md for each relevant upstream skill, then read only the references it requires.',
    'Skill files under /__skills__/ are owner-published, read-only, and outside the project workspace.',
    '',
    'Available skills:',
    ...[...metadataByName.values()]
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(({ name, description }) => `- /__skills__/${name}/SKILL.md — ${description}`),
    '</builder_skills>',
  ].join('\n');
  if (prompt.length > MAX_BUILDER_SKILL_PROMPT_CHARS) {
    throw new Error("Builder skill catalog exceeds Ghostbuild's system-prompt limit.");
  }
}

function validateRuntimeText(content: Uint8Array, path: string, repository: string): void {
  const filename = path.split('/').at(-1) ?? path;
  const dot = filename.lastIndexOf('.');
  const extension = dot === -1 ? '' : filename.slice(dot).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) {
    return;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    const roundTrip = new TextEncoder().encode(text);
    if (roundTrip.byteLength !== content.byteLength || !roundTrip.every((byte, index) => byte === content[index])) {
      throw new Error('round-trip mismatch');
    }
  } catch {
    throw new Error(`Upstream builder skill text resource is not canonical UTF-8: ${repository}/${path}`);
  }
}

function parsePointer(value: unknown): PublishedPointer | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'generation', 'skills']) ||
    value.version !== 1 ||
    typeof value.generation !== 'string' ||
    !DIGEST_PATTERN.test(value.generation) ||
    !Array.isArray(value.skills) ||
    value.skills.length === 0 ||
    value.skills.length > MAX_SKILLS ||
    !value.skills.every((name) => typeof name === 'string' && SKILL_NAME_PATTERN.test(name)) ||
    new Set(value.skills).size !== value.skills.length
  ) {
    return null;
  }
  return {
    version: 1,
    generation: value.generation,
    skills: value.skills as string[],
  };
}

function parseManifest(value: unknown, pointer: PublishedPointer): BuilderSkillFile[] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'generation', 'files']) ||
    value.version !== 1 ||
    value.generation !== pointer.generation ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_FILES
  ) {
    throw new Error('Published builder skill manifest is invalid.');
  }
  const files = value.files.map(parseManifestFile);
  const keys = files.map(({ name, path }) => `${name}/${path}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error('Published builder skill manifest contains duplicate files.');
  }
  const totalBytes = files.reduce((sum, { size }) => sum + size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('Published builder skill manifest exceeds its byte limit.');
  }
  const skills = [...new Set(files.map(({ name }) => name))].toSorted();
  if (
    skills.join('\n') !== pointer.skills.toSorted().join('\n') ||
    skills.some((name) => files.filter((file) => file.name === name && file.path === 'SKILL.md').length !== 1)
  ) {
    throw new Error('Published builder skill manifest does not match its pointer.');
  }
  return files;
}

function parseManifestFile(value: unknown): BuilderSkillFile {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['name', 'path', 'sha256', 'size']) ||
    typeof value.name !== 'string' ||
    !SKILL_NAME_PATTERN.test(value.name) ||
    typeof value.path !== 'string' ||
    !validRelativePath(value.path) ||
    typeof value.sha256 !== 'string' ||
    !DIGEST_PATTERN.test(value.sha256) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MAX_FILE_BYTES
  ) {
    throw new Error('Published builder skill manifest file is invalid.');
  }
  return {
    name: value.name,
    path: value.path,
    sha256: value.sha256,
    size: value.size,
  };
}

function generationInput(files: readonly BuilderSkillFile[]): string {
  return files.map(({ name, path, sha256: digest, size }) => `${name}\0${path}\0${digest}\0${size}`).join('\n');
}

function contentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md')) {
    return 'text/markdown';
  }
  if (lower.endsWith('.json')) {
    return 'application/json';
  }
  if (/\.(?:js|mjs|ts|tsx|jsx)$/.test(lower)) {
    return 'text/javascript';
  }
  if (/\.(?:txt|css|csv|html|xml|yaml|yml|svg|py|sh|bash)$/.test(lower)) {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

function validRelativePath(value: string): boolean {
  return !value.includes('\0') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).toSorted().join('\n') === keys.toSorted().join('\n');
}

function checksumHex(value: ArrayBuffer | undefined): string | null {
  if (!value) {
    return null;
  }
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

async function sha256(value: Uint8Array): Promise<string> {
  return digest('SHA-256', value);
}

async function gitBlobSha(value: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${value.byteLength}\0`);
  const input = new Uint8Array(header.byteLength + value.byteLength);
  input.set(header);
  input.set(value, header.byteLength);
  return digest('SHA-1', input);
}

async function digest(algorithm: 'SHA-1' | 'SHA-256', value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest(algorithm, Uint8Array.from(value).buffer));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
