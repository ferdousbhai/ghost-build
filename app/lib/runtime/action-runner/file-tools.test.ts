import type { WebContainer } from '@webcontainer/api';
import { describe, expect, test, vi } from 'vitest';
import { runStreamedFileAction } from './file-tools';
import type { ActionRunnerWorkspace, ActionState } from './types';

describe('runStreamedFileAction', () => {
  test.each([
    {
      name: 'path traversal',
      filePath: '/home/project/../../etc/passwd',
      content: 'blocked',
      error: /resolve under \/home\/project/,
    },
    {
      name: 'internal Ghostbuild placeholder files',
      filePath: '/home/project/.ghost-check.txt',
      content: 'placeholder',
      error: 'Ghostbuild internal check files cannot be written',
    },
    {
      name: 'package-manager credential files',
      filePath: '/home/project/.npmrc',
      content: '//registry.npmjs.org/:_authToken=secret',
      error: 'Local secret files are disabled for Ghostbuild projects',
    },
    {
      name: 'workspace-wide build-script bypasses',
      filePath: '/home/project/pnpm-workspace.yaml',
      content: 'dangerouslyAllowAllBuilds: true\n',
      error: 'must not define dangerouslyAllowAllBuilds',
    },
  ])('rejects $name before filesystem mutation', async ({ filePath, content, error }) => {
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const setGeneratedFileContent = vi.fn();
    const workspace: ActionRunnerWorkspace = {
      hasFile: vi.fn(),
      setGeneratedFileContent,
    };

    await expect(
      runStreamedFileAction(
        fileAction(filePath, content),
        { workdir: '/home/project', fs: { mkdir, writeFile } } as unknown as WebContainer,
        workspace,
      ),
    ).rejects.toThrow(error);

    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(setGeneratedFileContent).not.toHaveBeenCalled();
  });
});

function fileAction(filePath: string, content: string): ActionState {
  return { type: 'file', filePath, content } as ActionState;
}
