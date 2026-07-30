import JSZip from 'jszip';
import { normalizeProjectPath } from '~/lib/runtime/action-runner/project-path';
import type { BuilderWorkspaceRepository } from './builder-workspace';
import { BUILDER_PREVIEW_MAX_SOURCE_BYTES } from './builder-preview-types';

const EXCLUDED_ROOTS = new Set(['node_modules', 'dist', '.output', '.tanstack', '.wrangler']);

type BuilderWorkspaceSnapshot = {
  workspaceRevision: number;
  revision: string;
  bytes: Uint8Array<ArrayBuffer>;
};

export async function createBuilderWorkspaceSnapshot(
  workspace: BuilderWorkspaceRepository,
): Promise<BuilderWorkspaceSnapshot> {
  const startingState = workspace.getState();
  if (!startingState.initialized) {
    throw new Error('The durable project workspace is not initialized.');
  }
  if (startingState.totalBytes > BUILDER_PREVIEW_MAX_SOURCE_BYTES) {
    throw new Error('The durable project is too large for a bounded remote preview build.');
  }
  const files = workspace
    .listFiles()
    .map((file) => ({ ...file, relativePath: normalizeProjectPath(file.path).relativePath }))
    .filter((file) => !EXCLUDED_ROOTS.has(file.relativePath.split('/')[0] ?? ''))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const revision = await sha256Text(JSON.stringify(files.map((file) => [file.relativePath, file.sha256])));
  const archive = new JSZip();
  for (const file of files) {
    const loaded = await workspace.readFile(file.path);
    if (loaded.sha256 !== file.sha256) {
      throw new Error(`The durable project file changed while it was being captured: ${file.relativePath}`);
    }
    archive.file(file.relativePath, loaded.bytes, {
      binary: true,
      date: new Date(0),
      createFolders: false,
    });
  }
  const currentState = workspace.getState();
  if (currentState.revision !== startingState.revision) {
    throw new Error('The durable project workspace changed while it was being captured.');
  }
  const bytes = await archive.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });
  return {
    workspaceRevision: startingState.revision,
    revision,
    bytes: bytes as Uint8Array<ArrayBuffer>,
  };
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
