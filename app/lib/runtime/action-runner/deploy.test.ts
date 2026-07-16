import { afterEach, describe, expect, test, vi } from 'vitest';
import type { WebContainer } from '@webcontainer/api';
import { getAuthToken } from '~/lib/stores/sessionId';
import { waitForContainerBootState } from '~/lib/stores/containerBootState';
import { runDeploy } from './deploy';

vi.mock('~/lib/stores/containerBootState', () => ({
  ContainerBootState: { READY: 'ready' },
  waitForContainerBootState: vi.fn(() => Promise.resolve()),
}));

vi.mock('~/lib/stores/sessionId', () => ({
  getAuthToken: vi.fn(() => null),
}));

vi.mock('~/lib/stores/chatId', () => ({ chatIdStore: { get: vi.fn(() => 'chat-1') } }));

const EMPTY_WORKSPACE_REVISION = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('runDeploy production plan preparation', () => {
  test('keeps guest sessions behind sign-in without treating deployment as validation', async () => {
    vi.mocked(getAuthToken).mockReturnValue('guest_00000000-0000-4000-8000-000000000000');
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
      }),
    ).rejects.toThrow('no deploy in unit test');

    expect(waitForContainerBootState).toHaveBeenCalledOnce();
    expect(readFile).not.toHaveBeenCalled();
    expect(exportSnapshot).toHaveBeenCalledWith('.', {
      format: 'zip',
      excludes: expect.arrayContaining(['node_modules/**', '.env', '.dev.vars']),
    });
  });

  test('uploads an immutable snapshot for approval instead of running Wrangler in the browser', async () => {
    vi.mocked(getAuthToken).mockReturnValue('user-session');
    const exportSnapshot = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
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
      invocation: deployInvocation(),
      container: { fs: { readFile: vi.fn() }, export: exportSnapshot } as unknown as WebContainer,
      abortSignal: new AbortController().signal,
      workspace: {
        getFiles: () => ({}),
        getPreviewPort: () => undefined,
        hasFile: vi.fn(),
        setGeneratedFileContent: vi.fn(),
      },
    });

    expect(exportSnapshot).toHaveBeenCalledWith('.', {
      format: 'zip',
      excludes: expect.arrayContaining(['node_modules/**', 'dist/**', '.env', '.dev.vars']),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/deployments/plan?chatId=chat-1',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        state: 'awaiting-approval',
        revision: EMPTY_WORKSPACE_REVISION,
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
    const exportSnapshot = vi.fn();
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
    });
    expect(exportSnapshot).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, data: { state: 'validation-stale' } });
  });
});

function deployInvocation(validatedRevision = EMPTY_WORKSPACE_REVISION) {
  return {
    state: 'call' as const,
    toolCallId: 'deploy-1',
    toolName: 'deploy',
    args: { validatedRevision },
  };
}
