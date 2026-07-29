import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { WebContainer } from '@webcontainer/api';
import JSZip from 'jszip';
import { getAuthToken } from '~/lib/stores/sessionId';
import { runCommand } from './command';
import { DiagnosticsStore } from './diagnostics-store';
import { runValidateProject } from './validate-project';
import { DeploymentValidationStore } from './deployment-validation-store';
import type { ProjectBuildExecutor } from './project-build-executor';

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
    vi.mocked(getAuthToken).mockReturnValue(null);
  });

  test('returns a successful result tied to the current source revision', async () => {
    runCommandMock.mockResolvedValue(undefined);
    const result = await runValidateProject(await validationArgs());
    expect(result).toMatchObject({
      ok: true,
      data: {
        level: 'full',
        nextAction: 'sign-in-required',
        checks: [
          { name: 'typecheck', status: 'passed' },
          { name: 'lint', status: 'passed' },
          { name: 'build', status: 'passed' },
          { name: 'preview', status: 'passed' },
        ],
      },
    });
    expect((result.data as { revision: string }).revision).toMatch(/^[a-f0-9]{64}$/);
  });

  test('can route build checks through an injected build executor', async () => {
    const buildExecutor: ProjectBuildExecutor = {
      environment: 'remote-sandbox',
      run: vi.fn(async () => undefined),
    };

    const result = await runValidateProject(await validationArgs(undefined, undefined, undefined, buildExecutor));

    expect(result.ok).toBe(true);
    expect(buildExecutor.run).toHaveBeenCalledTimes(3);
    expect(buildExecutor.run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: ['pnpm', 'run', 'typecheck'] }),
    );
    expect(buildExecutor.run).toHaveBeenNthCalledWith(2, expect.objectContaining({ command: ['pnpm', 'run', 'lint'] }));
    expect(buildExecutor.run).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ command: ['pnpm', 'run', 'build'] }),
    );
    expect(runCommandMock).toHaveBeenCalledOnce();
  });

  test('returns structured diagnostics without exposing raw command output', async () => {
    runCommandMock.mockRejectedValueOnce(new Error('full compiler diagnostics')).mockResolvedValueOnce(undefined);
    const result = await runValidateProject(await validationArgs());
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
    const result = await runValidateProject(
      await validationArgs(undefined, ['export const app = true;', 'export const app = false;']),
    );
    expect(result).toMatchObject({ ok: false });
    expect((result.data as { checks: Array<{ name: string; status: string }> }).checks).toContainEqual(
      expect.objectContaining({ name: 'workspace-stability', status: 'failed' }),
    );
  });

  test('records a trusted deployment receipt only after full validation succeeds', async () => {
    runCommandMock.mockResolvedValue(undefined);
    const deploymentValidation = new DeploymentValidationStore();
    const result = await runValidateProject(await validationArgs(undefined, undefined, deploymentValidation));
    const revision = (result.data as { revision: string }).revision;

    expect(result.ok).toBe(true);
    expect(deploymentValidation.hasFullValidation(revision)).toBe(true);
  });

  test('does not record failed validation as deployment-ready', async () => {
    const deploymentValidation = new DeploymentValidationStore();
    runCommandMock.mockRejectedValueOnce(new Error('typecheck failed')).mockResolvedValue(undefined);
    const result = await runValidateProject(await validationArgs(undefined, undefined, deploymentValidation));
    expect(result.ok).toBe(false);
    expect(deploymentValidation.hasFullValidation((result.data as { revision: string }).revision)).toBe(false);
  });
});

async function validationArgs(
  diagnostics = new DiagnosticsStore(),
  sourceVersions = ['export const app = true;', 'export const app = true;'],
  deploymentValidation: DeploymentValidationStore | undefined = new DeploymentValidationStore(),
  buildExecutor?: ProjectBuildExecutor,
) {
  const snapshots = await Promise.all(sourceVersions.map((source) => zipSnapshot(source)));
  let exportCount = 0;
  const container = {
    export: vi.fn(async () => snapshots[Math.min(exportCount++, snapshots.length - 1)]),
  } as unknown as WebContainer;
  return {
    invocation: {
      state: 'call' as const,
      toolCallId: 'validate-1',
      toolName: 'validateProject',
      args: {},
    },
    container,
    abortSignal: new AbortController().signal,
    onOutput: vi.fn(),
    workspace: {
      getFiles: () => ({}),
      getPreviewPort: () => 4173,
      hasFile: () => true,
      setGeneratedFileContent: vi.fn(),
    },
    diagnostics,
    deploymentValidation: deploymentValidation ?? new DeploymentValidationStore(),
    buildExecutor: buildExecutor ?? {
      environment: 'browser',
      run: (command) => runCommand({ ...command, container }),
    },
  };
}

async function zipSnapshot(content: string) {
  const zip = new JSZip();
  zip.file('src/app.ts', content);
  return zip.generateAsync({ type: 'uint8array' });
}
