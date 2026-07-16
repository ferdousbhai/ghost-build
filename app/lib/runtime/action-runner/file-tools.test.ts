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
      getFiles: () => ({}),
      getPreviewPort: () => undefined,
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

  test('applies multiple replacements against the same original file', async () => {
    let written = '';
    const container = {
      fs: {
        readdir: vi.fn().mockRejectedValue(new Error('ENOTDIR')),
        readFile: vi.fn().mockResolvedValue('const one = 1;\nconst two = 2;\n'),
        mkdir: vi.fn(),
        writeFile: vi.fn(async (_path: string, content: string) => {
          written = content;
        }),
      },
    } as unknown as WebContainer;
    const result = await runFileTool(
      {
        state: 'call',
        toolCallId: 'call-2',
        toolName: 'edit',
        args: {
          path: '/home/project/src/app.ts',
          edits: [
            { old: 'one = 1', new: 'one = 10' },
            { old: 'two = 2', new: 'two = 20' },
          ],
        },
      },
      container,
      {
        getFiles: () => ({}),
        getPreviewPort: () => undefined,
        hasFile: () => true,
        setGeneratedFileContent: vi.fn(),
      },
    );
    expect(result).toMatchObject({ ok: true, data: { path: '/home/project/src/app.ts' } });
    expect(written).toBe('const one = 10;\nconst two = 20;\n');
  });

  test('accepts legacy single-edit invocations from stored transcripts', async () => {
    let written = '';
    const container = {
      fs: {
        readdir: vi.fn().mockRejectedValue(new Error('ENOTDIR')),
        readFile: vi.fn().mockResolvedValue('const before = true;\n'),
        mkdir: vi.fn(),
        writeFile: vi.fn(async (_path: string, content: string) => {
          written = content;
        }),
      },
    } as unknown as WebContainer;
    await runFileTool(
      {
        state: 'call',
        toolCallId: 'call-legacy',
        toolName: 'edit',
        args: { path: '/home/project/src/app.ts', old: 'before', new: 'after' },
      },
      container,
      {
        getFiles: () => ({}),
        getPreviewPort: () => undefined,
        hasFile: () => true,
        setGeneratedFileContent: vi.fn(),
      },
    );
    expect(written).toBe('const after = true;\n');
  });

  test('continues an unusually dense view range through view itself', async () => {
    const source = `${'x'.repeat(15_000)}\nsecond line\n`;
    const container = {
      fs: {
        readdir: vi.fn().mockRejectedValue(new Error('ENOTDIR')),
        readFile: vi.fn().mockResolvedValue(source),
      },
    } as unknown as WebContainer;
    const workspace = {
      getFiles: () => ({}),
      getPreviewPort: () => undefined,
      hasFile: () => true,
      setGeneratedFileContent: vi.fn(),
    };
    const first = await runFileTool(
      {
        state: 'call',
        toolCallId: 'view-1',
        toolName: 'view',
        args: { path: '/home/project/src/app.ts', view_range: [1, 3] },
      },
      container,
      workspace,
    );
    expect(first.coverage?.complete).toBe(false);
    const second = await runFileTool(
      {
        state: 'call',
        toolCallId: 'view-2',
        toolName: 'view',
        args: {
          path: '/home/project/src/app.ts',
          view_range: [1, 3],
          cursor: first.coverage?.nextCursor,
        },
      },
      container,
      workspace,
    );
    const content = (result: typeof first) => (result.data as { content: string }).content;
    expect(content(first) + content(second)).toBe(`${'x'.repeat(15_000)}\nsecond line\n`);
    expect(second.coverage?.complete).toBe(true);
  });
});
