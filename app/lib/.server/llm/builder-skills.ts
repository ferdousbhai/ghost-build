import { parse } from 'yaml';
/**
 * The react-start skill tree ships inside @tanstack/react-start, a direct template dependency
 * whose exact version the seeded lockfile pins. A freshly seeded workspace has no node_modules
 * and the reviewed installer only rewrites package.json and pnpm-lock.yaml, so a workspace
 * path under node_modules is unreadable when the catalog reaches the model. The tree is
 * inlined into a generated module by scripts/build-user-workspace-runtime.mjs because this
 * file is bundled both by Vite and, via BuilderAgent, by esbuild into the user workspace
 * runtime - and only Vite implements import.meta.glob.
 */
import { REACT_START_SKILL_FILES } from '~/generated/builder-skill-assets.generated';
import frontendDesignSkill from './skills/frontend-design/SKILL.md?raw';

const BUILDER_SKILL_ROOT = '/__skills__';
const MAX_BUILDER_SKILL_PROMPT_CHARS = 16_000;

/**
 * References bundled into this Worker and served read-only under /__skills__/. Everything
 * Cloudflare publishes is retrieved live through search_cloudflare_docs instead. The catalog
 * must never point at workspace files: the model reads them through the Computer VFS, which a
 * fresh seed does not populate beyond the template sources.
 */
const BUNDLED_SKILLS: readonly BundledSkillSource[] = [
  { name: 'frontend-design', files: new Map([['SKILL.md', frontendDesignSkill]]) },
  { name: 'react-start', files: bundledSkillFiles('react-start', REACT_START_SKILL_FILES) },
];

export type BuilderSkillReadResult = { kind: 'file' | 'directory'; content: string };

export type BuilderSkillReader = {
  read(path: string): Promise<BuilderSkillReadResult | null>;
};

type BuilderSkillContext = {
  prompt: string;
  reader: BuilderSkillReader;
};

type BundledSkillSource = { name: string; files: ReadonlyMap<string, string> };

type BundledSkill = { name: string; description: string; files: ReadonlyMap<string, string> };

/** Load the references bundled into this Worker. No network, no storage, no generation. */
export function createBuilderSkillContext(): BuilderSkillContext {
  const skills = BUNDLED_SKILLS.map(({ name, files }) => parseSkill(name, files));
  return { prompt: renderPrompt(skills), reader: createReader(skills) };
}

export function isBuilderSkillPath(path: string): boolean {
  const normalized = normalizeAbsolutePath(path);
  return normalized === BUILDER_SKILL_ROOT || normalized.startsWith(`${BUILDER_SKILL_ROOT}/`);
}

/** A bundled skill's generated file map, keyed by path inside the skill directory. */
function bundledSkillFiles(name: string, files: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  const map = new Map(Object.entries(files));
  if (!map.get('SKILL.md')) {
    throw new Error(`Bundled builder skill ${name} is missing SKILL.md.`);
  }
  return map;
}

type DeclaredSkillFrontmatter = { name?: unknown; description?: unknown };

function declaredSkillFrontmatter(value: unknown): DeclaredSkillFrontmatter {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const declared: DeclaredSkillFrontmatter = {};
  if ('name' in value) {
    declared.name = value.name;
  }
  if ('description' in value) {
    declared.description = value.description;
  }
  return declared;
}

/** The catalog quotes the skill's own description, so editing the file updates the prompt. */
function parseSkill(name: string, files: ReadonlyMap<string, string>): BundledSkill {
  const source = files.get('SKILL.md') ?? '';
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) {
    throw new Error(`Bundled builder skill ${name} has no frontmatter.`);
  }
  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1]!);
  } catch {
    throw new Error(`Bundled builder skill ${name} has invalid frontmatter.`);
  }
  const declared = declaredSkillFrontmatter(frontmatter);
  if (declared.name !== name || typeof declared.description !== 'string' || !declared.description) {
    throw new Error(`Bundled builder skill ${name} does not declare a matching name and description.`);
  }
  return { name, description: declared.description.trim(), files };
}

function renderPrompt(skills: readonly BundledSkill[]): string {
  const prompt = [
    '<builder_skills>',
    `Before implementation, use read to load the SKILL.md for each relevant reference below, then read only the files it points to. Files under ${BUILDER_SKILL_ROOT}/ are read-only and outside the project workspace.`,
    '',
    ...skills.map(({ name, description }) => `- ${BUILDER_SKILL_ROOT}/${name}/SKILL.md — ${description}`),
    '',
    'Read a full Cloudflare page with exec by appending /index.md to any developers.cloudflare.com URL; never fetch llms.txt or llms-full.txt, which exceed the turn budget.',
    '</builder_skills>',
  ].join('\n');
  if (prompt.length > MAX_BUILDER_SKILL_PROMPT_CHARS) {
    throw new Error('Bundled builder skill catalog exceeds the system-prompt limit.');
  }
  return prompt;
}

function createReader(skills: readonly BundledSkill[]): BuilderSkillReader {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    async read(path) {
      const target = parseSkillPath(path);
      const skill = target ? byName.get(target.name) : undefined;
      if (!target || !skill) {
        return null;
      }
      const file = target.path ? skill.files.get(target.path) : undefined;
      if (file !== undefined) {
        return { kind: 'file', content: file };
      }
      const listing = directoryListing(skill.files, target.path);
      return listing ? { kind: 'directory', content: listing } : null;
    },
  };
}

/** Immediate children of a directory inside one bundled skill; subdirectories carry a trailing slash. */
function directoryListing(files: ReadonlyMap<string, string>, directory: string): string | null {
  const prefix = directory ? `${directory}/` : '';
  const entries = new Set<string>();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) {
      continue;
    }
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    entries.add(slash === -1 ? rest : rest.slice(0, slash + 1));
  }
  return entries.size > 0 ? [...entries].sort().join('\n') : null;
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
