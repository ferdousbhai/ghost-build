import { r2, SkillRegistry, type SkillContent, type SkillSource } from 'agents/skills';

const BUILDER_SKILL_ROOT = '/__skills__';
export const BUILDER_SKILLS_POINTER_KEY = 'published/current.json';
const MAX_BUILDER_SKILL_PROMPT_CHARS = 16_000;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SKILLS = 64;
const MAX_SKILL_FILES = 4_000;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GENERATION_PATTERN = /^[a-f0-9]{64}$/;

type BuilderSkillsPointer = {
  version: 1;
  generation: string;
  skills: string[];
};

type BuilderSkillFile = {
  name: string;
  path: string;
  sha256: string;
  size: number;
};

export type BuilderSkillReadResult = { kind: 'file' | 'directory'; content: string };

export type BuilderSkillReader = {
  read(path: string): Promise<BuilderSkillReadResult | null>;
};

type BuilderSkillContext = {
  prompt: string;
  reader: BuilderSkillReader;
};

/** Load upstream Agent Skills from the owner-published, generation-pinned R2 tree. */
export async function createBuilderSkillContext(bucket: R2Bucket): Promise<BuilderSkillContext> {
  const pointer = parsePointer(await readObjectText(bucket, BUILDER_SKILLS_POINTER_KEY, MAX_POINTER_BYTES));
  const generationPrefix = `generations/${pointer.generation}`;
  const files = await parseManifest(
    await readObjectText(bucket, `${generationPrefix}/manifest.json`, MAX_MANIFEST_BYTES),
    pointer,
  );
  const prefix = `${generationPrefix}/skills/`;
  const source = withIntegrity(
    r2(bucket, {
      id: `ghostbuild-builder-skills:${pointer.generation}`,
      prefix,
      skills: pointer.skills,
      fingerprint: 'metadata',
    }),
    files,
  );
  const registry = new SkillRegistry([source]);
  const snapshot = await registry.snapshot();
  if (!snapshot.catalogPrompt || registry.warnings.length > 0) {
    throw new Error(registry.warnings.join('; ') || 'Owner-published builder skills are unavailable.');
  }
  const skills = await loadExpectedSkills(source, pointer.skills);
  const prompt = renderPrompt(skills);
  return { prompt, reader: createReader(source, skills) };
}

export function isBuilderSkillPath(path: string): boolean {
  const normalized = normalizeAbsolutePath(path);
  return normalized === BUILDER_SKILL_ROOT || normalized.startsWith(`${BUILDER_SKILL_ROOT}/`);
}

async function readObjectText(bucket: R2Bucket, key: string, maxBytes: number): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object || object.size > maxBytes) {
    return null;
  }
  return object.text();
}

function parsePointer(value: string | null): BuilderSkillsPointer {
  let parsed: unknown;
  try {
    parsed = value ? JSON.parse(value) : null;
  } catch {
    throw new Error('Owner-published builder skill pointer is invalid.');
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ['version', 'generation', 'skills']) ||
    parsed.version !== 1 ||
    typeof parsed.generation !== 'string' ||
    !GENERATION_PATTERN.test(parsed.generation) ||
    !Array.isArray(parsed.skills) ||
    parsed.skills.length === 0 ||
    parsed.skills.length > MAX_SKILLS ||
    !parsed.skills.every((name) => typeof name === 'string' && SKILL_NAME_PATTERN.test(name)) ||
    new Set(parsed.skills).size !== parsed.skills.length
  ) {
    throw new Error('Owner-published builder skill pointer is invalid.');
  }
  return { version: 1, generation: parsed.generation, skills: parsed.skills as string[] };
}

async function parseManifest(
  value: string | null,
  pointer: BuilderSkillsPointer,
): Promise<Map<string, BuilderSkillFile>> {
  let parsed: unknown;
  try {
    parsed = value ? JSON.parse(value) : null;
  } catch {
    throw new Error('Owner-published builder skill manifest is invalid.');
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ['version', 'generation', 'files']) ||
    parsed.version !== 1 ||
    parsed.generation !== pointer.generation ||
    !Array.isArray(parsed.files) ||
    parsed.files.length === 0 ||
    parsed.files.length > MAX_SKILL_FILES
  ) {
    throw new Error('Owner-published builder skill manifest is invalid.');
  }
  const files = parsed.files.map(parseManifestFile);
  const keys = files.map(fileKey);
  if (new Set(keys).size !== keys.length || (await sha256(generationInput(files))) !== pointer.generation) {
    throw new Error('Owner-published builder skill manifest integrity check failed.');
  }
  const manifestSkills = [...new Set(files.map(({ name }) => name))].toSorted();
  if (
    manifestSkills.join('\n') !== pointer.skills.toSorted().join('\n') ||
    manifestSkills.some((name) => files.filter((file) => file.name === name && file.path === 'SKILL.md').length !== 1)
  ) {
    throw new Error('Owner-published builder skill manifest does not match its pointer.');
  }
  return new Map(files.map((file) => [fileKey(file), file]));
}

function parseManifestFile(value: unknown): BuilderSkillFile {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['name', 'path', 'sha256', 'size']) ||
    typeof value.name !== 'string' ||
    !SKILL_NAME_PATTERN.test(value.name) ||
    typeof value.path !== 'string' ||
    !validResourcePath(value.path) ||
    typeof value.sha256 !== 'string' ||
    !GENERATION_PATTERN.test(value.sha256) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0
  ) {
    throw new Error('Owner-published builder skill manifest file is invalid.');
  }
  return { name: value.name, path: value.path, sha256: value.sha256, size: value.size };
}

function withIntegrity(source: SkillSource, files: Map<string, BuilderSkillFile>): SkillSource {
  return {
    ...source,
    async load(name) {
      const skill = await source.load(name);
      if (!skill?.rawContent) {
        return skill;
      }
      await requireIntegrity(files, name, 'SKILL.md', skill.rawContent);
      return skill;
    },
    async readResource(name, path) {
      const resource = await source.readResource?.(name, path);
      if (!resource) {
        return null;
      }
      await requireIntegrity(files, name, path, resource.content, resource.encoding ?? 'text');
      return resource;
    },
  };
}

async function requireIntegrity(
  files: Map<string, BuilderSkillFile>,
  name: string,
  path: string,
  content: string,
  encoding: 'text' | 'base64' = 'text',
): Promise<void> {
  const expected = files.get(fileKey({ name, path }));
  const bytes =
    encoding === 'base64'
      ? Uint8Array.from(atob(content), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(content);
  if (!expected || expected.size !== bytes.byteLength || expected.sha256 !== (await sha256(bytes))) {
    throw new Error(`Owner-published builder skill file failed integrity verification: ${name}/${path}`);
  }
}

async function loadExpectedSkills(source: SkillSource, expectedNames: string[]): Promise<Map<string, SkillContent>> {
  const descriptors = await source.list();
  const actualNames = descriptors.map(({ name }) => name).toSorted();
  if (actualNames.join('\n') !== expectedNames.toSorted().join('\n')) {
    throw new Error('Owner-published builder skill generation does not match its pointer.');
  }
  const loaded = await Promise.all(expectedNames.map((name) => source.load(name)));
  if (loaded.some((skill) => !skill?.rawContent)) {
    throw new Error('Owner-published builder skill content is unavailable.');
  }
  return new Map(loaded.map((skill) => [skill!.name, skill!]));
}

function renderPrompt(skills: Map<string, SkillContent>): string {
  const prompt = [
    '<builder_skills>',
    'Before implementation, use read to load the SKILL.md for each relevant upstream skill, then read only the references it requires.',
    `Skill files under ${BUILDER_SKILL_ROOT}/ are owner-published, read-only, and outside the project workspace.`,
    '',
    'Available skills:',
    ...[...skills.values()].map(({ name, description }) => `- ${BUILDER_SKILL_ROOT}/${name}/SKILL.md — ${description}`),
    '</builder_skills>',
  ].join('\n');
  if (prompt.length > MAX_BUILDER_SKILL_PROMPT_CHARS) {
    throw new Error('Owner-published builder skill catalog exceeds the system-prompt limit.');
  }
  return prompt;
}

function createReader(source: SkillSource, skills: Map<string, SkillContent>): BuilderSkillReader {
  return {
    async read(path) {
      const target = parseSkillPath(path);
      if (!target) {
        return null;
      }
      const skill = skills.get(target.name);
      if (!skill) {
        return null;
      }
      if (!target.path) {
        return directoryResult(skill, '');
      }
      if (target.path === 'SKILL.md') {
        return skill.rawContent ? { kind: 'file', content: skill.rawContent } : null;
      }
      const descriptor = skill.resources?.find(({ path: resourcePath }) => resourcePath === target.path);
      if (descriptor && (descriptor.encoding ?? 'text') === 'text') {
        const resource = await source.readResource?.(target.name, target.path);
        return resource && (resource.encoding ?? 'text') === 'text'
          ? { kind: 'file', content: resource.content }
          : null;
      }
      return directoryResult(skill, target.path);
    },
  };
}

function parseSkillPath(path: string): { name: string; path: string } | null {
  const withoutTrailingSlash = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (
    normalizeAbsolutePath(withoutTrailingSlash) !== withoutTrailingSlash ||
    !withoutTrailingSlash.startsWith(`${BUILDER_SKILL_ROOT}/`)
  ) {
    return null;
  }
  const [name, ...parts] = withoutTrailingSlash.slice(BUILDER_SKILL_ROOT.length + 1).split('/');
  if (!name) {
    return null;
  }
  return { name, path: parts.join('/') };
}

function directoryResult(skill: SkillContent, path: string): BuilderSkillReadResult | null {
  const prefix = path ? `${path}/` : '';
  const children = new Set<string>();
  if (!path) {
    children.add('SKILL.md');
  }
  for (const resource of skill.resources ?? []) {
    if (!resource.path.startsWith(prefix)) {
      continue;
    }
    const child = resource.path.slice(prefix.length).split('/')[0];
    if (child) {
      children.add(child);
    }
  }
  if (children.size === 0) {
    return null;
  }
  return {
    kind: 'directory',
    content: [...children]
      .toSorted()
      .map((child) =>
        skill.resources?.some(({ path: resourcePath }) => resourcePath.startsWith(`${prefix}${child}/`))
          ? `${child}/`
          : child,
      )
      .join('\n'),
  };
}

function generationInput(files: BuilderSkillFile[]): string {
  return files.map(({ name, path, sha256: digest, size }) => `${name}\0${path}\0${digest}\0${size}`).join('\n');
}

function fileKey(value: Pick<BuilderSkillFile, 'name' | 'path'>): string {
  return `${value.name}/${value.path}`;
}

function validResourcePath(path: string): boolean {
  return (
    !path.startsWith('/') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeAbsolutePath(path: string): string {
  if (!path.startsWith('/')) {
    return path;
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join('/')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).toSorted().join('\n') === keys.toSorted().join('\n');
}
