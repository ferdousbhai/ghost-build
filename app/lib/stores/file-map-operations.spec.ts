import type { WebContainer } from '@webcontainer/api';
import { map } from 'nanostores';
import { describe, expect, it, vi } from 'vitest';
import { WORK_DIR } from 'ghostbuild-agent/constants';
import type { FileMap } from 'ghostbuild-agent/types';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { prewarmFileMap } from './file-map-operations';

describe('prewarmFileMap', () => {
  it('purges mounted legacy secret files before reading ordinary project files without watcher events', async () => {
    const secretPaths = [
      `${WORK_DIR}/.npmrc`,
      `${WORK_DIR}/nested/.netrc`,
      `${WORK_DIR}/nested/_netrc`,
      `${WORK_DIR}/nested/.git-credentials`,
      `${WORK_DIR}/nested/.pypirc`,
      `${WORK_DIR}/nested/.yarnrc`,
      `${WORK_DIR}/nested/.yarnrc.yml`,
      `${WORK_DIR}/nested/.env.production`,
      `${WORK_DIR}/nested/.envrc`,
      `${WORK_DIR}/nested/.dev.vars.local`,
    ].map(getAbsolutePath);
    const rootGitConfigPath = getAbsolutePath(`${WORK_DIR}/.git/config`);
    const nestedGitConfigPath = getAbsolutePath(`${WORK_DIR}/packages/app/.git/config`);
    const packagePath = getAbsolutePath(`${WORK_DIR}/package.json`);
    const events: string[] = [];
    const removed = new Set<string>();
    const rm = vi.fn(async (filePath: string) => {
      events.push(`remove:${filePath}`);
      removed.add(filePath);
    });
    const readFile = vi.fn(async (filePath: string) => {
      events.push(`read:${filePath}`);
      expect(removed.size).toBe(secretPaths.length + 2);
      return new TextEncoder().encode('{}');
    });
    const initialFiles = {} as FileMap;
    initialFiles[secretPaths[0]] = { type: 'file', content: 'legacy-token', isBinary: false };
    initialFiles[rootGitConfigPath] = { type: 'file', content: 'root-token', isBinary: false };
    initialFiles[nestedGitConfigPath] = { type: 'file', content: 'nested-token', isBinary: false };
    const files = map<FileMap>(initialFiles);
    const fileSearch = vi.fn(async () => {
      events.push('search');
      expect(removed.has('.git')).toBe(true);
      return [...secretPaths, nestedGitConfigPath, packagePath];
    });
    const container = {
      workdir: WORK_DIR,
      internal: { fileSearch },
      fs: { rm, readFile },
    } as unknown as WebContainer;

    await prewarmFileMap(container, files);

    expect(rm.mock.calls.map(([filePath]) => filePath)).toEqual([
      '.git',
      '.npmrc',
      'nested/.netrc',
      'nested/_netrc',
      'nested/.git-credentials',
      'nested/.pypirc',
      'nested/.yarnrc',
      'nested/.yarnrc.yml',
      'nested/.env.production',
      'nested/.envrc',
      'nested/.dev.vars.local',
      'packages/app/.git',
    ]);
    expect(rm).toHaveBeenCalledWith('.git', { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith('packages/app/.git', { recursive: true, force: true });
    expect(fileSearch).toHaveBeenCalledWith([], WORK_DIR, { excludes: ['.gitignore', 'node_modules'] });
    expect(readFile).toHaveBeenCalledWith('package.json');
    expect(events.slice(0, 2)).toEqual(['remove:.git', 'search']);
    expect(events.findIndex((event) => event.startsWith('read:'))).toBeGreaterThan(
      events.findLastIndex((event) => event.startsWith('remove:')),
    );
    expect(files.get()[secretPaths[0]]).toBeUndefined();
    expect(files.get()[rootGitConfigPath]).toBeUndefined();
    expect(files.get()[nestedGitConfigPath]).toBeUndefined();
    expect(files.get()[packagePath]).toMatchObject({ type: 'file', content: '{}' });
  });

  it('fails closed before project reads when a legacy secret cannot be removed', async () => {
    const readFile = vi.fn();
    const fileSearch = vi.fn();
    const container = {
      workdir: WORK_DIR,
      internal: { fileSearch },
      fs: {
        rm: vi.fn(async () => {
          throw new Error('removal failed');
        }),
        readFile,
      },
    } as unknown as WebContainer;

    await expect(prewarmFileMap(container, map<FileMap>({}))).rejects.toThrow('removal failed');
    expect(fileSearch).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
