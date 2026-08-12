import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, posix, resolve, sep } from 'node:path';
import { parse } from 'yaml';

export const BUILDER_SKILLS_BUCKET = 'ghostbuild-builder-skills';
export const BUILDER_SKILLS_POINTER_KEY = 'published/current.json';
const MAX_SKILLS = 64;
const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function packBuilderSkills(directory) {
  const root = resolve(directory);
  const skillFiles = await rootSkillFiles(root);
  if (skillFiles.length === 0 || skillFiles.length > MAX_SKILLS) {
    throw new Error('Builder skill directory must contain a bounded set of SKILL.md files.');
  }

  const entries = [];
  const names = new Set();
  let totalBytes = 0;
  for (const skillFile of skillFiles) {
    const skillRoot = dirname(skillFile);
    const rawContent = await readRegularFile(skillFile);
    const name = parseSkillName(rawContent, skillFile);
    if (names.has(name)) {
      throw new Error(`Builder skills contain a duplicate name: ${name}`);
    }
    names.add(name);
    for (const path of await walk(skillRoot)) {
      const content = await readRegularBytes(path);
      totalBytes += content.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error('Builder skills exceed their aggregate publication limit.');
      }
      const relative = relativePath(skillRoot, path);
      entries.push({
        name,
        path: relative,
        content,
        contentType: contentType(relative),
      });
    }
  }
  if (entries.length > MAX_FILES) {
    throw new Error('Builder skills contain too many files.');
  }
  entries.sort((left, right) => `${left.name}/${left.path}`.localeCompare(`${right.name}/${right.path}`));
  const files = entries.map(({ name, path, content }) => ({
    name,
    path,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.byteLength,
  }));
  const generation = createHash('sha256').update(generationInput(files)).digest('hex');
  const pointer = { version: 1, generation, skills: [...names].sort() };
  const manifest = { version: 1, generation, files };
  return {
    entries,
    generation,
    pointer,
    pointerSerialized: JSON.stringify(pointer),
    manifestSerialized: JSON.stringify(manifest),
  };
}

async function rootSkillFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Builder skill directories must not be symbolic links: ${resolve(root, entry.name)}`);
    }
    if (!entry.isDirectory()) {
      continue;
    }
    const path = resolve(root, entry.name, 'SKILL.md');
    try {
      const stat = await lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        files.push(path);
      }
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return files.sort();
}

async function walk(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Builder skill files must not be symbolic links: ${path}`);
    }
    if (entry.isDirectory()) {
      result.push(...(await walk(path)));
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result.sort();
}

function parseSkillName(rawContent, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(rawContent);
  let frontmatter;
  try {
    frontmatter = match ? parse(match[1]) : null;
  } catch {
    frontmatter = null;
  }
  if (
    !frontmatter ||
    typeof frontmatter !== 'object' ||
    Array.isArray(frontmatter) ||
    !SKILL_NAME_PATTERN.test(frontmatter.name) ||
    typeof frontmatter.description !== 'string' ||
    frontmatter.description.trim().length === 0
  ) {
    throw new Error(`Builder skill has invalid Agent Skills frontmatter: ${path}`);
  }
  return frontmatter.name;
}

async function readRegularFile(path) {
  return new TextDecoder().decode(await readRegularBytes(path));
}

async function readRegularBytes(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_FILE_BYTES) {
    throw new Error(`Builder skill file is missing, empty, or too large: ${path}`);
  }
  return new Uint8Array(await readFile(path));
}

function relativePath(root, path) {
  if (!path.startsWith(`${root}${sep}`) && path !== resolve(root, 'SKILL.md')) {
    throw new Error(`Builder skill path escaped its root: ${path}`);
  }
  return path
    .slice(root.length + 1)
    .split(sep)
    .join(posix.sep);
}

function generationInput(files) {
  return files.map(({ name, path, sha256, size }) => `${name}\0${path}\0${sha256}\0${size}`).join('\n');
}

function contentType(path) {
  if (path.endsWith('.md')) {
    return 'text/markdown';
  }
  if (path.endsWith('.json')) {
    return 'application/json';
  }
  if (/\.(?:js|mjs|ts|tsx|jsx)$/.test(path)) {
    return 'text/javascript';
  }
  if (/\.(?:txt|css|html|xml|yaml|yml|svg)$/.test(path)) {
    return 'text/plain';
  }
  return 'application/octet-stream';
}
