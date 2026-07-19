import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { WebContainer } from '@webcontainer/api';
import JSZip from 'jszip';
import { getAuthToken } from '~/lib/stores/sessionId';
import { runCommand } from './command';
import { DiagnosticsStore } from './diagnostics-store';
import { runValidateProject } from './validate-project';
import { DeploymentValidationStore } from './deployment-validation-store';

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
    const result = await runValidateProject(await validationArgs(undefined, undefined, 'full', deploymentValidation));
    const revision = (result.data as { revision: string }).revision;

    expect(result.ok).toBe(true);
    expect(deploymentValidation.hasFullValidation(revision)).toBe(true);
  });

  test('does not record fast or failed full validation as deployment-ready', async () => {
    const deploymentValidation = new DeploymentValidationStore();
    runCommandMock.mockResolvedValue(undefined);
    const fast = await runValidateProject(await validationArgs(undefined, undefined, 'fast', deploymentValidation));
    expect(deploymentValidation.hasFullValidation((fast.data as { revision: string }).revision)).toBe(false);

    runCommandMock.mockRejectedValueOnce(new Error('typecheck failed')).mockResolvedValue(undefined);
    const full = await runValidateProject(await validationArgs(undefined, undefined, 'full', deploymentValidation));
    expect(full.ok).toBe(false);
    expect(deploymentValidation.hasFullValidation((full.data as { revision: string }).revision)).toBe(false);
  });
});

async function validationArgs(
  diagnostics = new DiagnosticsStore(),
  sourceVersions = ['export const app = true;', 'export const app = true;'],
  level: 'fast' | 'full' = 'fast',
  deploymentValidation = new DeploymentValidationStore(),
) {
  const snapshots = await Promise.all(sourceVersions.map((source) => zipSnapshot(source)));
  let exportCount = 0;
  return {
    invocation: {
      state: 'call' as const,
      toolCallId: 'validate-1',
      toolName: 'validateProject',
      args: { level },
    },
    container: {
      export: vi.fn(async () => snapshots[Math.min(exportCount++, snapshots.length - 1)]),
    } as unknown as WebContainer,
    abortSignal: new AbortController().signal,
    onOutput: vi.fn(),
    workspace: {
      getFiles: () => ({}),
      getPreviewPort: () => (level === 'full' ? 4173 : undefined),
      hasFile: () => true,
      setGeneratedFileContent: vi.fn(),
    },
    diagnostics,
    deploymentValidation,
  };
}

async function zipSnapshot(content: string) {
  const zip = new JSZip();
  zip.file('src/app.ts', content);
  return zip.generateAsync({ type: 'uint8array' });
}
