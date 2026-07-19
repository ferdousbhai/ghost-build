import type { WebContainer } from '@webcontainer/api';
import JSZip from 'jszip';
import { LOCAL_SECRET_FILE_EXPORT_EXCLUDES } from '~/utils/secretFiles';

const DEPLOYMENT_EXPORT_EXCLUDES = [
  'node_modules/**',
  'dist/**',
  '.output/**',
  '.tanstack/**',
  '.wrangler/**',
  ...LOCAL_SECRET_FILE_EXPORT_EXCLUDES,
] as const;

export async function contentRevision(content: string): Promise<string> {
  return sha256(content);
}

export async function queryFingerprint(value: unknown): Promise<string> {
  return (await sha256(JSON.stringify(value))).slice(0, 16);
}

export async function exportDeploymentSnapshot(container: WebContainer): Promise<Uint8Array> {
  return container.export('.', { format: 'zip', excludes: [...DEPLOYMENT_EXPORT_EXCLUDES] });
}

/**
 * Canonical digest of the actual exported file paths and bytes. ZIP container
 * metadata is intentionally excluded because it has no deployed effect and may
 * vary between otherwise identical exports.
 */
export async function deploymentSnapshotRevision(snapshot: Uint8Array): Promise<string> {
  const archive = await JSZip.loadAsync(snapshot);
  const paths = Object.keys(archive.files)
    .filter((filePath) => !archive.files[filePath]?.dir)
    .sort((left, right) => left.localeCompare(right));
  const records: Array<[string, string]> = [];
  for (const filePath of paths) {
    const fileDigest = await sha256Bytes(await archive.files[filePath]!.async('uint8array'));
    records.push([filePath, fileDigest]);
  }
  return sha256(JSON.stringify(records));
}

async function sha256(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
