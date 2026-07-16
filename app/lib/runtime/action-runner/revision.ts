import type { FileMap } from 'ghostbuild-agent/types';

const REVISION_EXCLUDES = /(^|\/)(?:node_modules|dist|\.output|\.tanstack|\.wrangler|\.git)(?:\/|$)/;

export async function contentRevision(content: string): Promise<string> {
  return sha256(content);
}

export async function queryFingerprint(value: unknown): Promise<string> {
  return (await sha256(JSON.stringify(value))).slice(0, 16);
}

export async function workspaceRevision(files: FileMap): Promise<string> {
  const records = Object.entries(files)
    .filter(([filePath, entry]) => entry?.type === 'file' && !entry.isBinary && !REVISION_EXCLUDES.test(filePath))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, entry]) => [filePath, entry?.type === 'file' ? entry.content : '']);
  return sha256(JSON.stringify(records));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
