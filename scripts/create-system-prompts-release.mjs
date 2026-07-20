import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const RELEASE_TAG_PATTERN = /^prompts-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG_GLOB = 'prompts-v*';
const RELEASE_ARTIFACT = 'ghostbuild-system-prompts.txt';
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

/**
 * @typedef {{error?: Error, status: number | null, stdout?: string | Buffer}} ReleaseCommandResult
 * @typedef {(command: string, args: string[], options: object) => ReleaseCommandResult} ReleaseSpawn
 * @typedef {{
 *   commitSha?: string;
 *   cwd?: string;
 *   spawn?: ReleaseSpawn;
 *   tags?: readonly string[];
 *   tagsAtCommit?: readonly string[];
 * }} CreateReleaseOptions
 */

/** @param {readonly string[]} tags */
export function nextSystemPromptsReleaseTag(tags) {
  let latest = null;

  for (const tag of tags) {
    const match = RELEASE_TAG_PATTERN.exec(tag.trim());
    if (!match) {
      continue;
    }
    const version = match.slice(1).map((part) => BigInt(part));
    if (!latest || compareVersions(version, latest) > 0) {
      latest = version;
    }
  }

  if (!latest) {
    return 'prompts-v0.0.1';
  }
  return `prompts-v${latest[0]}.${latest[1]}.${latest[2] + 1n}`;
}

/**
 * @param {string} tag
 * @param {string | undefined} commitSha
 * @param {{tagExists?: boolean}} [options]
 */
export function systemPromptsReleaseArgs(tag, commitSha, { tagExists = false } = {}) {
  if (!RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error(`Invalid system-prompts release tag: ${tag}.`);
  }
  if (!COMMIT_SHA_PATTERN.test(commitSha ?? '')) {
    throw new Error('GITHUB_SHA must be a full lowercase Git commit SHA.');
  }

  const tagSelection = tagExists ? ['--verify-tag'] : ['--target', commitSha];
  return [
    'release',
    'create',
    tag,
    RELEASE_ARTIFACT,
    ...tagSelection,
    '--title',
    `Ghostbuild System Prompts ${tag.slice('prompts-v'.length)}`,
    '--notes',
    'Compiled Ghostbuild system prompts generated reproducibly from the tagged source revision.',
  ];
}

/** @param {CreateReleaseOptions} [options] */
export function createSystemPromptsRelease({
  commitSha = process.env.GITHUB_SHA,
  cwd = process.cwd(),
  spawn = runCommand,
  tags,
  tagsAtCommit,
} = {}) {
  validateCommitSha(commitSha);
  const artifactPath = resolve(cwd, RELEASE_ARTIFACT);
  const artifact = lstatSync(artifactPath);
  if (!artifact.isFile() || artifact.isSymbolicLink()) {
    throw new Error(`${RELEASE_ARTIFACT} must be a regular, non-symbolic-link file.`);
  }

  const availableTags = tags ?? readReleaseTags({ cwd, spawn });
  const commitTags = tagsAtCommit ?? readReleaseTags({ commitSha, cwd, spawn });
  const existingTag = latestSystemPromptsReleaseTag(commitTags);
  const tag = existingTag ?? nextSystemPromptsReleaseTag(availableTags);
  if (existingTag && releaseExists({ cwd, spawn, tag })) {
    return tag;
  }

  const result = spawn('gh', systemPromptsReleaseArgs(tag, commitSha, { tagExists: Boolean(existingTag) }), {
    cwd,
    stdio: 'inherit',
  });
  requireSuccessfulSpawn(result, 'gh release create');
  return tag;
}

function readReleaseTags({ commitSha, cwd, spawn }) {
  const args = ['tag', '--list', RELEASE_TAG_GLOB];
  if (commitSha) {
    args.push('--points-at', commitSha);
  }
  const result = spawn('git', args, { cwd, encoding: 'utf8' });
  requireSuccessfulSpawn(result, 'git tag --list');
  return String(result.stdout ?? '').split(/\r?\n/);
}

function latestSystemPromptsReleaseTag(tags) {
  const validTags = tags.filter((tag) => RELEASE_TAG_PATTERN.test(tag.trim()));
  if (validTags.length === 0) {
    return null;
  }
  const nextTag = nextSystemPromptsReleaseTag(validTags);
  const [major, minor, patch] = RELEASE_TAG_PATTERN.exec(nextTag)
    .slice(1)
    .map((part) => BigInt(part));
  return `prompts-v${major}.${minor}.${patch - 1n}`;
}

function releaseExists({ cwd, spawn, tag }) {
  const result = spawn('gh', ['release', 'view', tag, '--json', 'tagName'], { cwd, stdio: 'ignore' });
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(`gh release view failed with exit status ${result.status ?? 'unknown'}.`);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

function requireSuccessfulSpawn(result, command) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit status ${result.status ?? 'unknown'}.`);
  }
}

function runCommand(command, args, options) {
  return spawnSync(command, args, options);
}

function validateCommitSha(commitSha) {
  if (!COMMIT_SHA_PATTERN.test(commitSha ?? '')) {
    throw new Error('GITHUB_SHA must be a full lowercase Git commit SHA.');
  }
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  try {
    const tag = createSystemPromptsRelease();
    console.log(`Release ${tag} is ready.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
