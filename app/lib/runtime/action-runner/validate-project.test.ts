import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { WebContainer } from '@webcontainer/api';
import type { FileMap } from 'ghostbuild-agent/types';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { getAuthToken } from '~/lib/stores/sessionId';
import { runCommand } from './command';
import { DiagnosticsStore } from './diagnostics-store';
import { runValidateProject } from './validate-project';

vi.mock('~/lib/stores/containerBootState', () => ({
  ContainerBootState: { READY: 'ready' },
  waitForContainerBootState: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/lib/stores/sessionId', () => ({ getAuthToken: vi.fn(() => null) }));
vi.mock('./command', () => ({ runCommand: vi.fn() }));

const runCommandMock = vi.mocked(runCommand);

describe('runValidateProject', () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    vi.mocked(getAuthToken).mockReturnValue('guest_00000000-0000-4000-8000-000000000000');
  });

  test('returns a successful result tied to the current source revision', async () => {
    runCommandMock.mockResolvedValue(undefined);
    const result = await runValidateProject(validationArgs());
    expect(result).toMatchObject({
      ok: true,
      data: {
        level: 'fast',
        nextAction: 'sign-in-required',
        checks: [
          { name: 'typecheck', status: 'passed' },
          { name: 'lint', status: 'passed' },
        ],
      },
    });
    expect((result.data as { revision: string }).revision).toMatch(/^[a-f0-9]{64}$/);
  });

  test('returns structured diagnostics without exposing raw command output', async () => {
    runCommandMock.mockRejectedValueOnce(new Error('full compiler diagnostics')).mockResolvedValueOnce(undefined);
    const result = await runValidateProject(validationArgs());
    expect(result).toMatchObject({ ok: false });
    expect((result.data as { checks: Array<{ name: string; status: string }> }).checks).toContainEqual(
      expect.objectContaining({ name: 'typecheck', status: 'failed' }),
    );
    expect((result.data as unknown as { diagnostics: Array<{ message: string }> }).diagnostics).toContainEqual(
      expect.objectContaining({ message: 'full compiler diagnostics' }),
    );
  });

  test('does not certify a revision that changed while checks were running', async () => {
    runCommandMock.mockResolvedValue(undefined);
    let readCount = 0;
    const result = await runValidateProject(
      validationArgs(undefined, () => {
        readCount += 1;
        return sourceFiles(readCount === 1 ? 'export const app = true;' : 'export const app = false;');
      }),
    );
    expect(result).toMatchObject({ ok: false });
    expect((result.data as { checks: Array<{ name: string; status: string }> }).checks).toContainEqual(
      expect.objectContaining({ name: 'workspace-stability', status: 'failed' }),
    );
  });
});

function validationArgs(
  diagnostics = new DiagnosticsStore(),
  getFiles = () => sourceFiles('export const app = true;'),
) {
  return {
    invocation: {
      state: 'call' as const,
      toolCallId: 'validate-1',
      toolName: 'validateProject',
      args: { level: 'fast' },
    },
    container: {} as WebContainer,
    abortSignal: new AbortController().signal,
    onOutput: vi.fn(),
    workspace: {
      getFiles,
      getPreviewPort: () => undefined,
      hasFile: () => true,
      setGeneratedFileContent: vi.fn(),
    },
    diagnostics,
  };
}

function sourceFiles(content: string): FileMap {
  return {
    [getAbsolutePath('src/app.ts')]: { type: 'file', content, isBinary: false },
  } as FileMap;
}
