import { describe, expect, test, vi } from 'vitest';
import type { WebContainer } from '@webcontainer/api';
import { runFileTool } from './file-tools';
import type { ActionRunnerWorkspace } from './types';

describe('runFileTool', () => {
  test('rejects internal Ghostbuild placeholder files', async () => {
    const writeFile = vi.fn();
    const mkdir = vi.fn();
    const container = { fs: { mkdir, writeFile } } as unknown as WebContainer;
    const workspace: ActionRunnerWorkspace = {
      hasFile: vi.fn(),
      setGeneratedFileContent: vi.fn(),
    };

    await expect(
      runFileTool(
        {
          state: 'call',
          toolCallId: 'call-1',
          toolName: 'writeFile',
          args: { path: '/home/project/.ghost-check.txt', content: 'placeholder' },
        },
        container,
        workspace,
      ),
    ).rejects.toThrow('Ghostbuild internal check files cannot be written');

    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(workspace.setGeneratedFileContent).not.toHaveBeenCalled();
  });
});
