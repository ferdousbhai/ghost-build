import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { BuilderWorkspaceRepository } from './builder-workspace';
import { createBuilderWorkspaceSnapshot } from './builder-workspace-snapshot';

describe('createBuilderWorkspaceSnapshot', () => {
  it('captures one immutable durable revision and excludes generated dependency output', async () => {
    const state = { initialized: true, revision: 7 };
    const workspace = {
      getState: () => ({
        ...state,
        resetRevision: 1,
        fileCount: 3,
        totalBytes: 15,
        seeding: false,
      }),
      listFiles: () => [
        file('/home/project/src/index.ts', 'source-sha'),
        file('/home/project/package.json', 'package-sha'),
        file('/home/project/node_modules/untrusted/index.js', 'dependency-sha'),
      ],
      readFile: async (path: string) => {
        const content = path.endsWith('package.json') ? '{"name":"app"}' : 'export {}';
        return {
          path,
          encoding: 'utf8',
          content,
          bytes: new TextEncoder().encode(content),
          sha256: path.endsWith('package.json') ? 'package-sha' : 'source-sha',
          size: content.length,
          revision: 7,
        };
      },
    } as unknown as BuilderWorkspaceRepository;

    const snapshot = await createBuilderWorkspaceSnapshot(workspace);
    const archive = await JSZip.loadAsync(snapshot.bytes);

    expect(snapshot.workspaceRevision).toBe(7);
    expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(archive.files).sort()).toEqual(['package.json', 'src/index.ts']);
    expect(await archive.file('src/index.ts')?.async('string')).toBe('export {}');
  });

  it('fails rather than mixing files from two durable revisions', async () => {
    let revision = 4;
    const workspace = {
      getState: () => ({
        initialized: true,
        revision,
        resetRevision: 1,
        fileCount: 1,
        totalBytes: 9,
        seeding: false,
      }),
      listFiles: () => [file('/home/project/src/index.ts', 'source-sha')],
      readFile: async (path: string) => {
        revision = 5;
        return {
          path,
          encoding: 'utf8',
          content: 'export {}',
          bytes: new TextEncoder().encode('export {}'),
          sha256: 'source-sha',
          size: 9,
          revision: 4,
        };
      },
    } as unknown as BuilderWorkspaceRepository;

    await expect(createBuilderWorkspaceSnapshot(workspace)).rejects.toThrow(
      'workspace changed while it was being captured',
    );
  });

  it('rejects a source tree that exceeds the remote preview memory budget', async () => {
    const workspace = {
      getState: () => ({
        initialized: true,
        revision: 1,
        resetRevision: 1,
        fileCount: 1,
        totalBytes: 32 * 1024 * 1024 + 1,
        seeding: false,
      }),
    } as unknown as BuilderWorkspaceRepository;

    await expect(createBuilderWorkspaceSnapshot(workspace)).rejects.toThrow(
      'too large for a bounded remote preview build',
    );
  });
});

function file(path: string, sha256: string) {
  return {
    path,
    encoding: 'utf8' as const,
    size: 9,
    sha256,
    revision: 7,
  };
}
