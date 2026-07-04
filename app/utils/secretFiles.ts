import { pathSegments } from './pathNames';

export const LOCAL_SECRET_FILE_IGNORE_PATHS = [
  '.env',
  '.env.',
  '.env.local',
  '.envrc',
  '.dev.vars',
  '.dev.vars.',
] as const;

const LOCAL_SECRET_FILE_NAMES = new Set(['.env', '.envrc', '.dev.vars']);

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

  throw new Error(
    `Local secret files are disabled for Ghostbuild projects: ${filePath}. Use Cloudflare Worker bindings or wrangler secret put NAME instead.`,
  );
}
