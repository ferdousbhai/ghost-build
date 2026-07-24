import type { FSWatchCallback, WebContainer } from '@webcontainer/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORK_DIR } from 'ghostbuild-agent/constants';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { MANAGED_WEBCONTAINER_NPMRC_CONTENT } from '~/utils/secretFiles';
import { FilesStore } from './files';

const containerBootMocks = vi.hoisted(() => ({
  waitForContainerBootState: vi.fn(() => Promise.resolve()),
}));

vi.mock('./containerBootState', () => ({
  ContainerBootState: { READY: 4 },
  waitForContainerBootState: containerBootMocks.waitForContainerBootState,
}));

describe('FilesStore public filesystem watcher', () => {
  let project: MemoryProject;
  let container: WebContainer;
  let store: FilesStore;

  beforeEach(async () => {
    containerBootMocks.waitForContainerBootState.mockResolvedValue(undefined);
    project = new MemoryProject();
    project.setFile('src/current.ts', 'version one');
    project.setFile('src/remove-me.ts', 'remove me');
    project.setFile('old/nested/file.ts', 'old directory');
    container = project.container;
    store = new FilesStore(Promise.resolve(container));

    await vi.waitFor(() => expect(project.watch).toHaveBeenCalledWith('.', { recursive: false }, expect.any(Function)));
    await store.prewarmWorkdir(container);
  });

  it('waits for the initial workspace setup before attaching the recursive watcher', async () => {
    let markReady: () => void = () => undefined;
    containerBootMocks.waitForContainerBootState.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          markReady = resolve;
        }),
    );
    const delayedProject = new MemoryProject();

    new FilesStore(Promise.resolve(delayedProject.container));
    await Promise.resolve();
    await Promise.resolve();

    expect(containerBootMocks.waitForContainerBootState).toHaveBeenCalledWith(4);
    expect(delayedProject.watch).not.toHaveBeenCalled();

    markReady();
    await vi.waitFor(() =>
      expect(delayedProject.watch).toHaveBeenCalledWith('.', { recursive: false }, expect.any(Function)),
    );
  });

  it('reconciles added, changed, and removed files and directories', async () => {
    project.setFile('src/current.ts', 'version two');
    project.setFile('src/added.ts', 'added file');
    project.setFile('new/nested/file.ts', 'new directory');
    project.remove('src/remove-me.ts');
    project.remove('old');

    project.emit('change', 'src/current.ts');
    project.emit('rename', 'src/added.ts');
    project.emit('rename', 'new');
    project.emit('rename', 'src/remove-me.ts');
    project.emit('rename', 'old');
    await store.flushFileEvents();

    expect(project.watch).toHaveBeenCalledWith('.', { recursive: false }, expect.any(Function));
    expect(project.watch).toHaveBeenCalledWith('src', { recursive: true }, expect.any(Function));
    expect(store.files.get()[getAbsolutePath('src/current.ts')]).toEqual(textFile('version two'));
    expect(store.files.get()[getAbsolutePath('src/added.ts')]).toEqual(textFile('added file'));
    expect(store.files.get()[getAbsolutePath('new')]).toEqual({ type: 'folder' });
    expect(store.files.get()[getAbsolutePath('new/nested')]).toEqual({ type: 'folder' });
    expect(store.files.get()[getAbsolutePath('new/nested/file.ts')]).toEqual(textFile('new directory'));
    expect(store.files.get()[getAbsolutePath('src/remove-me.ts')]).toBeUndefined();
    expect(store.files.get()[getAbsolutePath('old')]).toBeUndefined();
    expect(store.files.get()[getAbsolutePath('old/nested/file.ts')]).toBeUndefined();
  });

  it('collapses rapid duplicate events and skips excluded watcher paths', async () => {
    project.setFile('src/current.ts', 'one read only');
    project.setFile('.gitignore', 'ignored');
    project.setFile('node_modules/pkg/index.js', 'dependency');
    project.setFile('.wrangler/tmp/bundle.js', 'generated worker bundle');
    project.setFile('dist/assets/index.js', 'generated client bundle');
    project.events.length = 0;

    project.emit('change', 'src/current.ts');
    project.emit('change', 'src/current.ts');
    project.emit('rename', 'src/current.ts');
    project.emit('rename', '.gitignore');
    project.emit('change', '.gitignore');
    project.emit('rename', 'node_modules/pkg/index.js');
    project.emit('rename', '.wrangler/tmp/bundle.js');
    project.emit('rename', 'dist/assets/index.js');
    await store.flushFileEvents();

    expect(project.events.filter((event) => event === 'readdir:src')).toHaveLength(1);
    expect(project.events.filter((event) => event === 'read:src/current.ts')).toHaveLength(1);
    expect(project.events).not.toContain('readdir:node_modules/pkg');
    expect(project.events).not.toContain('read:.gitignore');
    expect(project.events).not.toContain('read:node_modules/pkg/index.js');
    expect(project.events).not.toContain('read:.wrangler/tmp/bundle.js');
    expect(project.events).not.toContain('read:dist/assets/index.js');
    expect(project.events).not.toContain('remove:.git');
    expect(store.files.get()[getAbsolutePath('src/current.ts')]).toEqual(textFile('one read only'));
    expect(store.files.get()[getAbsolutePath('.gitignore')]).toBeUndefined();
    expect(store.files.get()[getAbsolutePath('node_modules/pkg/index.js')]).toBeUndefined();
    expect(store.files.get()[getAbsolutePath('.wrangler/tmp/bundle.js')]).toBeUndefined();
    expect(store.files.get()[getAbsolutePath('dist/assets/index.js')]).toBeUndefined();
  });

  it('drops dependency install events before allocating a watcher buffer', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    for (let index = 0; index < 1_000; index += 1) {
      project.emit('rename', `node_modules/pkg-${index}/index.js`);
      project.emit('rename', `.wrangler/tmp/build-${index}.js`);
    }

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('purges watcher-reported and traversal-discovered secrets before reconciling ordinary files', async () => {
    const reportedSecretPath = getAbsolutePath('nested/.env.local');
    const discoveredGitPath = getAbsolutePath('packages/app/.git/config');
    store.setGeneratedFile(reportedSecretPath, 'stale secret');
    store.setGeneratedFile(discoveredGitPath, 'stale git token');
    store.userWrites.set(reportedSecretPath, Date.now());
    project.setFile('nested/.env.local', 'secret');
    project.setFile('packages/app/.git/config', 'token');
    project.setFile('src/current.ts', 'safe update');
    project.events.length = 0;

    project.emit('rename', new TextEncoder().encode('nested/.env.local'));
    project.emit('rename', 'packages/app');
    project.emit('change', `${WORK_DIR}/src/current.ts`);
    await store.flushFileEvents();

    expect(project.has('nested/.env.local')).toBe(false);
    expect(project.has('packages/app/.git')).toBe(false);
    expect(store.files.get()[reportedSecretPath]).toBeUndefined();
    expect(store.files.get()[discoveredGitPath]).toBeUndefined();
    expect(store.userWrites.has(reportedSecretPath)).toBe(false);
    expect(store.files.get()[getAbsolutePath('src/current.ts')]).toEqual(textFile('safe update'));
    expect(project.events).toContain('remove:nested/.env.local');
    expect(project.events).toContain('remove:packages/app/.git');
    expect(project.events.findIndex((event) => event.startsWith('read:'))).toBeGreaterThan(
      project.events.findLastIndex((event) => event.startsWith('remove:')),
    );
  });

  it('keeps the inert managed npmrc on disk without exposing it in project state', async () => {
    const npmrcPath = getAbsolutePath('.npmrc');
    store.setGeneratedFile(npmrcPath, 'stale content');
    store.userWrites.set(npmrcPath, Date.now());
    project.setFile('.npmrc', MANAGED_WEBCONTAINER_NPMRC_CONTENT);
    project.events.length = 0;

    project.emit('rename', '.npmrc');
    await store.flushFileEvents();

    expect(project.has('.npmrc')).toBe(true);
    expect(store.files.get()[npmrcPath]).toBeUndefined();
    expect(store.userWrites.has(npmrcPath)).toBe(false);
    expect(project.events).toContain('read:.npmrc');
    expect(project.events).not.toContain('remove:.npmrc');
  });

  it('purges an npmrc that differs from the managed marker', async () => {
    project.setFile('.npmrc', '//registry.npmjs.org/:_authToken=secret');
    project.events.length = 0;

    project.emit('change', '.npmrc');
    await store.flushFileEvents();

    expect(project.has('.npmrc')).toBe(false);
    expect(store.files.get()[getAbsolutePath('.npmrc')]).toBeUndefined();
    expect(project.events).toContain('read:.npmrc');
    expect(project.events).toContain('remove:.npmrc');
  });

  it('keeps ordinary map content unchanged when a watcher-triggered secret purge fails', async () => {
    project.setFile('.env.local', 'secret');
    project.setFile('src/current.ts', 'must not be exposed by this reconciliation');
    project.failRemovalFor = '.env.local';

    project.emit('rename', '.env.local');
    project.emit('change', 'src/current.ts');
    await store.flushFileEvents();

    expect(project.has('.env.local')).toBe(true);
    expect(store.files.get()[getAbsolutePath('.env.local')]).toBeUndefined();
    expect(store.files.get()[getAbsolutePath('src/current.ts')]).toEqual(textFile('version one'));
  });
});

class MemoryProject {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>(['.']);
  readonly events: string[] = [];
  failRemovalFor: string | undefined;
  readonly watchers = new Map<string, { recursive: boolean; listener: FSWatchCallback }>();

  readonly watch = vi.fn((filename: string, options: { recursive?: boolean }, listener: FSWatchCallback) => {
    const normalizedFilename = normalize(filename);
    this.watchers.set(normalizedFilename, { recursive: options.recursive ?? false, listener });
    return {
      close: vi.fn(() => {
        this.watchers.delete(normalizedFilename);
      }),
    };
  });

  readonly container = {
    workdir: WORK_DIR,
    fs: {
      watch: this.watch,
      readdir: vi.fn(async (directoryPath: string) => {
        const normalizedDirectory = normalize(directoryPath);
        this.events.push(`readdir:${normalizedDirectory}`);
        const entries = new Map<string, 'file' | 'directory'>();
        for (const candidate of this.directories) {
          if (candidate !== '.' && dirname(candidate) === normalizedDirectory) {
            entries.set(basename(candidate), 'directory');
          }
        }
        for (const candidate of this.files.keys()) {
          if (dirname(candidate) === normalizedDirectory) {
            entries.set(basename(candidate), 'file');
          }
        }
        return Array.from(entries, ([name, type]) => ({
          name,
          isFile: () => type === 'file',
          isDirectory: () => type === 'directory',
        }));
      }),
      readFile: vi.fn(async (filePath: string, encoding?: string) => {
        const normalizedPath = normalize(filePath);
        this.events.push(`read:${normalizedPath}`);
        const content = this.files.get(normalizedPath);
        if (!content) {
          throw new Error(`ENOENT: ${normalizedPath}`);
        }
        return encoding ? new TextDecoder().decode(content) : content;
      }),
      rm: vi.fn(async (filePath: string) => {
        const normalizedPath = normalize(filePath);
        this.events.push(`remove:${normalizedPath}`);
        if (normalizedPath === this.failRemovalFor) {
          throw new Error(`removal failed: ${normalizedPath}`);
        }
        this.remove(normalizedPath);
      }),
    },
  } as unknown as WebContainer;

  setFile(filePath: string, content: string): void {
    const normalizedPath = normalize(filePath);
    this.ensureDirectories(dirname(normalizedPath));
    this.files.set(normalizedPath, new TextEncoder().encode(content));
  }

  remove(filePath: string): void {
    const normalizedPath = normalize(filePath);
    const childPrefix = `${normalizedPath}/`;
    this.files.delete(normalizedPath);
    for (const candidate of Array.from(this.files.keys())) {
      if (candidate.startsWith(childPrefix)) {
        this.files.delete(candidate);
      }
    }
    this.directories.delete(normalizedPath);
    for (const candidate of Array.from(this.directories)) {
      if (candidate.startsWith(childPrefix)) {
        this.directories.delete(candidate);
      }
    }
  }

  has(filePath: string): boolean {
    const normalizedPath = normalize(filePath);
    return this.files.has(normalizedPath) || this.directories.has(normalizedPath);
  }

  emit(event: 'rename' | 'change', filePath: string | Uint8Array): void {
    if (this.watchers.size === 0) {
      throw new Error('Watcher has not initialized');
    }
    const decodedPath = typeof filePath === 'string' ? filePath : new TextDecoder().decode(filePath);
    const normalizedPath = normalize(decodedPath.replace(`${WORK_DIR}/`, ''));
    for (const [watchedDirectory, watcher] of this.watchers) {
      if (watchedDirectory === '.') {
        const rootEntry = normalizedPath.split('/')[0];
        watcher.listener(event, typeof filePath === 'string' ? rootEntry : new TextEncoder().encode(rootEntry));
        continue;
      }
      if (normalizedPath === watchedDirectory) {
        watcher.listener(event, watchedDirectory);
        continue;
      }
      const watchedPrefix = `${watchedDirectory}/`;
      if (!normalizedPath.startsWith(watchedPrefix)) {
        continue;
      }
      const watchedPath = watcher.recursive ? normalizedPath.slice(watchedPrefix.length) : basename(normalizedPath);
      watcher.listener(event, typeof filePath === 'string' ? watchedPath : new TextEncoder().encode(watchedPath));
    }
  }

  private ensureDirectories(directoryPath: string): void {
    if (directoryPath === '.') {
      return;
    }
    const segments = directoryPath.split('/');
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      this.directories.add(current);
    }
  }
}

function normalize(filePath: string): string {
  return filePath.replace(/^\.\//, '').replace(/\/+$/g, '') || '.';
}

function dirname(filePath: string): string {
  const separatorIndex = filePath.lastIndexOf('/');
  return separatorIndex === -1 ? '.' : filePath.slice(0, separatorIndex);
}

function basename(filePath: string): string {
  const separatorIndex = filePath.lastIndexOf('/');
  return separatorIndex === -1 ? filePath : filePath.slice(separatorIndex + 1);
}

function textFile(content: string) {
  return { type: 'file' as const, content, isBinary: false };
}
