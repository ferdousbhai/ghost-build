import type { WebContainer } from '@webcontainer/api';
import { describe, expect, test, vi } from 'vitest';
import JSZip from 'jszip';
import { deploymentSnapshotRevision, exportDeploymentSnapshot } from './revision';

describe('deploymentSnapshotRevision', () => {
  test('is stable across ZIP metadata while committing every file path and binary byte', async () => {
    const first = await snapshot(Uint8Array.of(1, 2), new Date('2025-01-01T00:00:00Z'));
    const sameContents = await snapshot(Uint8Array.of(1, 2), new Date('2026-01-01T00:00:00Z'));
    const changedBinary = await snapshot(Uint8Array.of(1, 3), new Date('2025-01-01T00:00:00Z'));

    await expect(deploymentSnapshotRevision(sameContents)).resolves.toBe(await deploymentSnapshotRevision(first));
    await expect(deploymentSnapshotRevision(changedBinary)).resolves.not.toBe(await deploymentSnapshotRevision(first));
  });

  test('excludes ecosystem credential files from the exported deployment boundary', async () => {
    const exportSnapshot = vi.fn().mockResolvedValue(new Uint8Array());

    await exportDeploymentSnapshot({ export: exportSnapshot } as unknown as WebContainer);

    expect(exportSnapshot).toHaveBeenCalledWith('.', {
      format: 'zip',
      excludes: expect.arrayContaining([
        '.git',
        '.git/**',
        '**/.git',
        '**/.git/**',
        '.npmrc',
        '**/.npmrc',
        '.netrc',
        '**/.netrc',
        '_netrc',
        '**/_netrc',
        '.git-credentials',
        '**/.git-credentials',
        '.pypirc',
        '**/.pypirc',
        '.yarnrc',
        '**/.yarnrc',
        '.yarnrc.yml',
        '**/.yarnrc.yml',
      ]),
    });
  });
});

async function snapshot(binary: Uint8Array, date: Date) {
  const zip = new JSZip();
  zip.file('src/app.ts', 'export const app = true;', { date });
  zip.file('public/logo.png', binary, { binary: true, date });
  return zip.generateAsync({ type: 'uint8array' });
}
