import type { WebContainer } from '@webcontainer/api';
import { map } from 'nanostores';
import { describe, expect, it, vi } from 'vitest';
import { WORK_DIR } from 'ghostbuild-agent/constants';
import type { FileMap } from 'ghostbuild-agent/types';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { reconcileFileMap } from './file-map-operations';

describe('reconcileFileMap', () => {
  it('traverses with public APIs, purges secrets and git data, and excludes dependencies and gitignore files', async () => {
    const events: string[] = [];
    const removed = new Set<string>();
    const directoryEntries = new Map([
      [
        '.',
        [
          file('.gitignore'),
          file('.npmrc'),
          directory('empty'),
          directory('node_modules'),
          file('package.json'),
          directory('packages'),
          directory('src'),
        ],
      ],
      ['empty', []],
      ['packages', [directory('app')]],
      ['packages/app', [directory('.git'), file('README.md')]],
      ['src', [file('.env.production'), file('index.ts')]],
    ]);
    const readdir = vi.fn(async (directoryPath: string) => {
      events.push(`readdir:${directoryPath}`);
      return directoryEntries.get(directoryPath) ?? [];
    });
    const rm = vi.fn(async (filePath: string) => {
      events.push(`remove:${filePath}`);
      removed.add(filePath);
    });
    const readFile = vi.fn(async (filePath: string) => {
      events.push(`read:${filePath}`);
      expect(removed).toEqual(new Set(['.git', '.npmrc', 'packages/app/.git', 'src/.env.production']));
      return new TextEncoder().encode(filePath === 'package.json' ? '{}' : filePath);
    });
    const initialFiles = {
      [getAbsolutePath('.git/config')]: textFile('legacy-git-token'),
      [getAbsolutePath('.npmrc')]: textFile('legacy-registry-token'),
      [getAbsolutePath('.gitignore')]: textFile('legacy-ignore'),
      [getAbsolutePath('node_modules/pkg/index.js')]: textFile('legacy-dependency'),
      [getAbsolutePath('removed.ts')]: textFile('stale'),
    } as FileMap;
    const files = map<FileMap>(initialFiles);
    const container = {
      workdir: WORK_DIR,
      fs: { readdir, readFile, rm },
    } as unknown as WebContainer;

    await reconcileFileMap(container, files);

    expect(rm.mock.calls.map(([filePath]) => filePath)).toEqual([
      '.git',
      '.npmrc',
      'packages/app/.git',
      'src/.env.production',
    ]);
    expect(rm).toHaveBeenCalledWith('.git', { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith('packages/app/.git', { recursive: true, force: true });
    expect(readdir).toHaveBeenCalledWith('.', { withFileTypes: true });
    expect(readdir).not.toHaveBeenCalledWith('node_modules', expect.anything());
    expect(readFile.mock.calls.map(([filePath]) => filePath)).toEqual([
      'package.json',
      'packages/app/README.md',
      'src/index.ts',
    ]);
    expect(events.findIndex((event) => event.startsWith('read:'))).toBeGreaterThan(
      events.findLastIndex((event) => event.startsWith('remove:')),
    );

    expect(files.get()).toEqual({
      [getAbsolutePath('empty')]: { type: 'folder' },
      [getAbsolutePath('package.json')]: textFile('{}'),
      [getAbsolutePath('packages')]: { type: 'folder' },
      [getAbsolutePath('packages/app')]: { type: 'folder' },
      [getAbsolutePath('packages/app/README.md')]: textFile('packages/app/README.md'),
      [getAbsolutePath('src')]: { type: 'folder' },
      [getAbsolutePath('src/index.ts')]: textFile('src/index.ts'),
    });
  });

  it('fails closed before traversal when the root git directory cannot be removed', async () => {
    const readdir = vi.fn();
    const readFile = vi.fn();
    const container = {
      workdir: WORK_DIR,
      fs: {
        rm: vi.fn(async () => {
          throw new Error('root removal failed');
        }),
        readdir,
        readFile,
      },
    } as unknown as WebContainer;

    await expect(reconcileFileMap(container, map<FileMap>({}))).rejects.toThrow('root removal failed');
    expect(readdir).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('fails closed before ordinary project reads when a discovered secret cannot be removed', async () => {
    const readFile = vi.fn();
    const rm = vi.fn(async (filePath: string) => {
      if (filePath === '.env.local') {
        throw new Error('secret removal failed');
      }
    });
    const container = {
      workdir: WORK_DIR,
      fs: {
        rm,
        readdir: vi.fn(async () => [file('.env.local'), file('package.json')]),
        readFile,
      },
    } as unknown as WebContainer;

    await expect(reconcileFileMap(container, map<FileMap>({}))).rejects.toThrow('secret removal failed');
    expect(rm.mock.calls.map(([filePath]) => filePath)).toEqual(['.git', '.env.local']);
    expect(readFile).not.toHaveBeenCalled();
  });
});

function file(name: string) {
  return {
    name,
    isFile: () => true,
    isDirectory: () => false,
  };
}

function directory(name: string) {
  return {
    name,
    isFile: () => false,
    isDirectory: () => true,
  };
}

function textFile(content: string) {
  return { type: 'file' as const, content, isBinary: false };
}
