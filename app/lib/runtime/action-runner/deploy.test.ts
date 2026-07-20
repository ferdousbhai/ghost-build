import { afterEach, describe, expect, test, vi } from 'vitest';
import type { WebContainer } from '@webcontainer/api';
import { getAuthToken } from '~/lib/stores/sessionId';
import { waitForContainerBootState } from '~/lib/stores/containerBootState';
import { runDeploy } from './deploy';
import { deploymentSnapshotRevision } from './revision';
import JSZip from 'jszip';
import { DeploymentValidationStore } from './deployment-validation-store';

vi.mock('~/lib/stores/containerBootState', () => ({
  ContainerBootState: { READY: 'ready' },
  waitForContainerBootState: vi.fn(() => Promise.resolve()),
}));

vi.mock('~/lib/stores/sessionId', () => ({
  getAuthToken: vi.fn(() => null),
}));

vi.mock('~/lib/stores/chatId', () => ({ chatIdStore: { get: vi.fn(() => 'chat-1') } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('runDeploy production plan preparation', () => {
  test('keeps unauthenticated sessions behind Cloudflare authorization without treating deployment as validation', async () => {
    vi.mocked(getAuthToken).mockReturnValue(null);
    const exportSnapshot = vi.fn();

    const result = await runDeploy({
      invocation: deployInvocation(),
      container: { export: exportSnapshot } as unknown as WebContainer,
      abortSignal: new AbortController().signal,
      workspace: {
        getFiles: () => ({}),
        getPreviewPort: () => undefined,
        hasFile: vi.fn(),
        setGeneratedFileContent: vi.fn(),
      },
      deploymentValidation: new DeploymentValidationStore(),
    });

    expect(waitForContainerBootState).not.toHaveBeenCalled();
    expect(exportSnapshot).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, data: { state: 'sign-in-required' } });
  });

  test('waits for container readiness before capturing the signed-in production snapshot', async () => {
    vi.mocked(getAuthToken).mockReturnValue('user-session');
    const readFile = vi.fn();
    const exportSnapshot = vi.fn().mockRejectedValue(new Error('no deploy in unit test'));

    await expect(
      runDeploy({
        invocation: deployInvocation(),
        container: { fs: { readFile }, export: exportSnapshot } as unknown as WebContainer,
        abortSignal: new AbortController().signal,
        workspace: {
          getFiles: () => ({}),
          getPreviewPort: () => undefined,
          hasFile: vi.fn(),
          setGeneratedFileContent: vi.fn(),
        },
        deploymentValidation: new DeploymentValidationStore(),
      }),
    ).rejects.toThrow('no deploy in unit test');

    expect(waitForContainerBootState).toHaveBeenCalledOnce();
    expect(readFile).not.toHaveBeenCalled();
    expect(exportSnapshot).toHaveBeenCalledWith('.', {
      format: 'zip',
      excludes: expect.arrayContaining(['node_modules/**', '.npmrc', '**/.npmrc', '.env', '.dev.vars']),
    });
  });

  test('uploads an immutable snapshot for approval instead of running Wrangler in the browser', async () => {
    vi.mocked(getAuthToken).mockReturnValue('user-session');
    const snapshot = await zipSnapshot({ 'src/app.ts': 'export const app = true;' });
    const revision = await deploymentSnapshotRevision(snapshot);
    const deploymentValidation = validatedRevisionStore(revision);
    const exportSnapshot = vi.fn().mockResolvedValue(snapshot);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        {
          deployment: {
            id: 'deployment-1',
            planDigest: 'a'.repeat(64),
            plan: { resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }] },
          },
        },
        { status: 201 },
      ),
    );

    const result = await runDeploy({
      invocation: deployInvocation(revision),
      container: { fs: { readFile: vi.fn() }, export: exportSnapshot } as unknown as WebContainer,
      abortSignal: new AbortController().signal,
      workspace: {
        getFiles: () => ({}),
        getPreviewPort: () => undefined,
        hasFile: vi.fn(),
        setGeneratedFileContent: vi.fn(),
      },
      deploymentValidation,
    });

    expect(exportSnapshot).toHaveBeenCalledWith('.', {
      format: 'zip',
      excludes: expect.arrayContaining(['node_modules/**', 'dist/**', '.npmrc', '**/.npmrc', '.env', '.dev.vars']),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/deployments/plan?chatId=chat-1',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        state: 'awaiting-approval',
        revision,
        deployment: {
          id: 'deployment-1',
          planDigest: 'a'.repeat(64),
          resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
        },
      },
    });
  });

  test('refuses to snapshot a workspace revision that was not validated', async () => {
    vi.mocked(getAuthToken).mockReturnValue('user-session');
    const exportSnapshot = vi.fn().mockResolvedValue(await zipSnapshot({ 'src/app.ts': 'changed' }));
    const result = await runDeploy({
      invocation: deployInvocation('a'.repeat(64)),
      container: { export: exportSnapshot } as unknown as WebContainer,
      abortSignal: new AbortController().signal,
      workspace: {
        getFiles: () => ({}),
        getPreviewPort: () => undefined,
        hasFile: vi.fn(),
        setGeneratedFileContent: vi.fn(),
      },
      deploymentValidation: validatedRevisionStore('a'.repeat(64)),
    });
    expect(exportSnapshot).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, data: { state: 'validation-stale' } });
  });

  test('rejects changed binary bytes even when the text-only file map is unchanged', async () => {
    vi.mocked(getAuthToken).mockReturnValue('user-session');
    const validatedSnapshot = await zipSnapshot({ 'src/app.ts': 'same', 'public/logo.png': Uint8Array.of(1, 2) });
    const changedSnapshot = await zipSnapshot({ 'src/app.ts': 'same', 'public/logo.png': Uint8Array.of(1, 3) });
    const validatedRevision = await deploymentSnapshotRevision(validatedSnapshot);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = await runDeploy({
      invocation: deployInvocation(validatedRevision),
      container: { export: vi.fn().mockResolvedValue(changedSnapshot) } as unknown as WebContainer,
      abortSignal: new AbortController().signal,
      workspace: {
        getFiles: () => ({ '/home/project/public/logo.png': { type: 'file', content: '', isBinary: true } }) as never,
        getPreviewPort: () => undefined,
        hasFile: vi.fn(),
        setGeneratedFileContent: vi.fn(),
      },
      deploymentValidation: validatedRevisionStore(validatedRevision),
    });
    expect(result).toMatchObject({ ok: false, data: { state: 'validation-stale', validatedRevision } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects a model-supplied current revision without a trusted full-validation receipt', async () => {
    vi.mocked(getAuthToken).mockReturnValue('user-session');
    const snapshot = await zipSnapshot({ 'src/app.ts': 'export const app = true;' });
    const revision = await deploymentSnapshotRevision(snapshot);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await runDeploy({
      invocation: deployInvocation(revision),
      container: { export: vi.fn().mockResolvedValue(snapshot) } as unknown as WebContainer,
      abortSignal: new AbortController().signal,
      workspace: {
        getFiles: () => ({}),
        getPreviewPort: () => undefined,
        hasFile: vi.fn(),
        setGeneratedFileContent: vi.fn(),
      },
      deploymentValidation: new DeploymentValidationStore(),
    });

    expect(result).toMatchObject({ ok: false, data: { state: 'validation-required', currentRevision: revision } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function deployInvocation(validatedRevision = 'a'.repeat(64)) {
  return {
    state: 'call' as const,
    toolCallId: 'deploy-1',
    toolName: 'deploy',
    args: { validatedRevision },
  };
}

async function zipSnapshot(files: Record<string, string | Uint8Array>) {
  const zip = new JSZip();
  for (const [filePath, content] of Object.entries(files)) {
    zip.file(filePath, content);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

function validatedRevisionStore(revision: string): DeploymentValidationStore {
  const store = new DeploymentValidationStore();
  store.recordFullValidation(revision);
  return store;
}
