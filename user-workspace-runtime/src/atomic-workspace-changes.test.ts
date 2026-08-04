import type { Workspace } from '@cloudflare/computer';
import { describe, expect, it } from 'vitest';
import { applyAtomicWorkspaceChanges } from './atomic-workspace-changes';

describe('applyAtomicWorkspaceChanges', () => {
  it('commits every write and recursive delete in one transaction', () => {
    const workspace = new TestWorkspace({
      '/home/project/old/a.txt': { content: 'old', mode: 0o644 },
    });

    expect(
      applyAtomicWorkspaceChanges(workspace.asWorkspace(), [
        { kind: 'delete', path: '/home/project/old' },
        { kind: 'write', path: '/home/project/new/a.txt', bytes: new TextEncoder().encode('new'), mode: 0o755 },
      ]),
    ).toEqual(['/home/project/old', '/home/project/new/a.txt']);

    expect(workspace.files.has('/home/project/old/a.txt')).toBe(false);
    expect(workspace.files.get('/home/project/new/a.txt')).toEqual({ content: 'new', mode: 0o755 });
    expect(workspace.transactions).toBe(1);
  });

  it('rolls back earlier changes when any later filesystem operation fails', () => {
    const workspace = new TestWorkspace({
      '/home/project/a.txt': { content: 'before', mode: 0o644 },
      '/home/project/blocker': { content: 'file-not-directory', mode: 0o644 },
    });

    expect(() =>
      applyAtomicWorkspaceChanges(workspace.asWorkspace(), [
        { kind: 'write', path: '/home/project/a.txt', bytes: new TextEncoder().encode('after') },
        { kind: 'write', path: '/home/project/blocker/nested.txt', bytes: new TextEncoder().encode('never') },
      ]),
    ).toThrow('ENOTDIR');

    expect(workspace.files.get('/home/project/a.txt')?.content).toBe('before');
    expect(workspace.files.has('/home/project/blocker/nested.txt')).toBe(false);
    expect(workspace.transactions).toBe(1);
  });

  it('preserves an executable file mode when an overwrite omits mode', () => {
    const workspace = new TestWorkspace({
      '/home/project/script.sh': { content: 'before', mode: 0o755 },
    });

    applyAtomicWorkspaceChanges(workspace.asWorkspace(), [
      { kind: 'write', path: '/home/project/script.sh', bytes: new TextEncoder().encode('after') },
    ]);

    expect(workspace.files.get('/home/project/script.sh')).toEqual({ content: 'after', mode: 0o755 });
  });
});

type TestFile = { content: string; mode: number };

class TestWorkspace {
  files: Map<string, TestFile>;
  readonly directories = new Set(['/']);
  transactions = 0;

  constructor(files: Record<string, TestFile>) {
    this.files = new Map(Object.entries(files));
    for (const path of this.files.keys()) {
      this.addParents(path);
    }
  }

  asWorkspace(): Workspace {
    const self = this;
    return {
      db: {
        transactionSync<T>(closure: () => T): T {
          self.transactions += 1;
          const files = new Map(self.files);
          const directories = new Set(self.directories);
          try {
            return closure();
          } catch (error) {
            self.files = files;
            self.directories.clear();
            for (const path of directories) {
              self.directories.add(path);
            }
            throw error;
          }
        },
      },
      provider: () => ({
        lstatSync: (path: string) => {
          const file = self.files.get(path);
          if (file) {
            return stat(false, file.mode);
          }
          if (self.directories.has(path)) {
            return stat(true, 0o755);
          }
          throw pathError('ENOENT');
        },
        readdirSync: (path: string) => self.children(path),
        unlinkSync: (path: string) => {
          if (!self.files.delete(path)) {
            throw pathError('ENOENT');
          }
        },
        rmdirSync: (path: string) => {
          if (self.children(path).length > 0) {
            throw pathError('ENOTEMPTY');
          }
          self.directories.delete(path);
        },
        mkdirSync: (path: string) => self.addDirectory(path),
        writeFileSync: (path: string, bytes: Uint8Array, options?: { mode?: number }) => {
          self.files.set(path, { content: new TextDecoder().decode(bytes), mode: options?.mode ?? 0o644 });
        },
      }),
    } as unknown as Workspace;
  }

  private addParents(path: string): void {
    const segments = path.split('/').slice(1, -1);
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      this.directories.add(current);
    }
  }

  private addDirectory(path: string): void {
    const segments = path.split('/').slice(1);
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      if (this.files.has(current)) {
        throw pathError('ENOTDIR');
      }
      this.directories.add(current);
    }
  }

  private children(path: string): string[] {
    const prefix = path === '/' ? '/' : `${path}/`;
    return [...this.directories, ...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && candidate !== path)
      .map((candidate) => candidate.slice(prefix.length).split('/')[0]!)
      .filter((name, index, names) => name && names.indexOf(name) === index);
  }
}

function stat(directory: boolean, mode: number) {
  return { isDirectory: () => directory, mode };
}

function pathError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
