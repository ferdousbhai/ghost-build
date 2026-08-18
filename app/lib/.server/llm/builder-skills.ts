import { parse } from 'yaml';
import frontendDesignSkill from './skills/frontend-design/SKILL.md?raw';

const BUILDER_SKILL_ROOT = '/__skills__';
const MAX_BUILDER_SKILL_PROMPT_CHARS = 16_000;

/**
 * References that ship with Ghostbuild itself and are reviewed in this repository
 * like any other source. Everything Cloudflare publishes is retrieved live through
 * search_cloudflare_docs instead, and every framework reference is read from the version the
 * project actually installed.
 */
const BUNDLED_SKILLS = [{ name: 'frontend-design', source: frontendDesignSkill }] as const;

/**
 * TanStack ships its skills inside the packages the template depends on directly, so the
 * project's own node_modules always matches the version it builds against. Only a direct
 * dependency resolves under pnpm's layout; a transitive one is not hoisted and would leave
 * the catalog advertising a file the model cannot open.
 */
export const PROJECT_SKILL_POINTERS = [
  {
    path: '/home/project/node_modules/@tanstack/react-start/skills/react-start/SKILL.md',
    description: 'TanStack Start: routing, server functions, server routes, and the execution model.',
  },
] as const;

export type BuilderSkillReadResult = { kind: 'file' | 'directory'; content: string };

export type BuilderSkillReader = {
  read(path: string): Promise<BuilderSkillReadResult | null>;
};

type BuilderSkillContext = {
  prompt: string;
  reader: BuilderSkillReader;
};

type BundledSkill = { name: string; description: string; content: string };

/** Load the references bundled into this Worker. No network, no storage, no generation. */
export function createBuilderSkillContext(): BuilderSkillContext {
  const skills = BUNDLED_SKILLS.map(({ name, source }) => parseSkill(name, source));
  return { prompt: renderPrompt(skills), reader: createReader(skills) };
}

export function isBuilderSkillPath(path: string): boolean {
  const normalized = normalizeAbsolutePath(path);
  return normalized === BUILDER_SKILL_ROOT || normalized.startsWith(`${BUILDER_SKILL_ROOT}/`);
}

/** The catalog quotes the skill's own description, so editing the file updates the prompt. */
function parseSkill(name: string, source: string): BundledSkill {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) {
    throw new Error(`Bundled builder skill ${name} has no frontmatter.`);
  }
  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1]!) as unknown;
  } catch {
    throw new Error(`Bundled builder skill ${name} has invalid frontmatter.`);
  }
  const declared = frontmatter as { name?: unknown; description?: unknown } | null;
  if (declared?.name !== name || typeof declared.description !== 'string' || !declared.description) {
    throw new Error(`Bundled builder skill ${name} does not declare a matching name and description.`);
  }
  return { name, description: declared.description, content: source };
}

function renderPrompt(skills: readonly BundledSkill[]): string {
  const prompt = [
    '<builder_skills>',
    `Before implementation, use read to load the SKILL.md for each relevant reference below, then read only the files it points to. Files under ${BUILDER_SKILL_ROOT}/ are read-only and outside the project workspace.`,
    '',
    ...skills.map(({ name, description }) => `- ${BUILDER_SKILL_ROOT}/${name}/SKILL.md — ${description}`),
    ...PROJECT_SKILL_POINTERS.map(({ path, description }) => `- ${path} — ${description}`),
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
      if (!target.path) {
        return { kind: 'directory', content: 'SKILL.md' };
      }
      return target.path === 'SKILL.md' ? { kind: 'file', content: skill.content } : null;
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
