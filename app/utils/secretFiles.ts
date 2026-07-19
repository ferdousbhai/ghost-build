import { pathSegments } from './pathNames';

const LOCAL_CREDENTIAL_FILE_NAMES = [
  '.npmrc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pypirc',
  '.yarnrc',
  '.yarnrc.yml',
] as const;
const PROJECT_DEPENDENCY_HOOK_FILE_NAMES = ['.pnpmfile.cjs', '.pnpmfile.js'] as const;
const FORBIDDEN_LOCAL_FILE_NAMES = [...LOCAL_CREDENTIAL_FILE_NAMES, ...PROJECT_DEPENDENCY_HOOK_FILE_NAMES] as const;

export const LOCAL_SECRET_FILE_IGNORE_PATHS = [
  '.git',
  ...FORBIDDEN_LOCAL_FILE_NAMES,
  '.env',
  '.env.',
  '.env.local',
  '.envrc',
  '.dev.vars',
  '.dev.vars.',
] as const;

/** WebContainer export globs; kept separate from watcher prefix markers. */
export const LOCAL_SECRET_FILE_EXPORT_EXCLUDES = [
  '.git',
  '.git/**',
  '**/.git',
  '**/.git/**',
  ...FORBIDDEN_LOCAL_FILE_NAMES.flatMap((name) => [name, `**/${name}`]),
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '.envrc',
  '**/.envrc',
  '.dev.vars',
  '.dev.vars.*',
  '**/.dev.vars',
  '**/.dev.vars.*',
] as const;

const LOCAL_SECRET_FILE_NAMES = new Set([...FORBIDDEN_LOCAL_FILE_NAMES, '.git', '.env', '.envrc', '.dev.vars']);
const PROJECT_DEPENDENCY_HOOK_FILE_NAME_SET = new Set<string>(PROJECT_DEPENDENCY_HOOK_FILE_NAMES);

export function isLocalSecretFilePath(filePath: string) {
  return pathSegments(filePath).some(
    (segment) =>
      LOCAL_SECRET_FILE_NAMES.has(segment) || segment.startsWith('.env.') || segment.startsWith('.dev.vars.'),
  );
}

export function assertNotLocalSecretFilePath(filePath: string) {
  if (!isLocalSecretFilePath(filePath)) {
    return;
  }

  if (pathSegments(filePath).some((segment) => PROJECT_DEPENDENCY_HOOK_FILE_NAME_SET.has(segment))) {
    throw new Error(
      `Project dependency hook files are disabled for Ghostbuild projects: ${filePath}. Use the reviewed pnpm workspace policy instead.`,
    );
  }

  throw new Error(
    `Local secret files are disabled for Ghostbuild projects: ${filePath}. Use Cloudflare Worker bindings or wrangler secret put NAME instead.`,
  );
}
