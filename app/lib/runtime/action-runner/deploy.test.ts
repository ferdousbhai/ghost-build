import { afterEach, describe, expect, test, vi } from 'vitest';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { ActionCommandTimeoutError } from './errors';
import { getAuthToken } from '~/lib/stores/sessionId';
import { waitForContainerBootState } from '~/lib/stores/containerBootState';
import { runCommand, runDeploy } from './deploy';

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
  vi.useRealTimers();
});

describe('runDeploy guest app check', () => {
  test('checks generated source without spawning browser-heavy validation commands for guests', async () => {
    vi.mocked(getAuthToken).mockReturnValue('guest_00000000-0000-4000-8000-000000000000');
    const spawn = vi.fn();
    const readFile = vi.fn().mockResolvedValue('export function HabitTracker() { return <main>Habit tracker</main>; }');

    const result = await runDeploy({
      container: { fs: { readFile }, spawn } as unknown as WebContainer,
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      workspace: {
        hasFile: vi.fn(),
        setGeneratedFileContent: vi.fn(),
      },
    });

    expect(waitForContainerBootState).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith('src/routes/index.tsx', 'utf-8');
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toContain('Ghostbuild app check complete');
    expect(result).toContain('Sign in to deploy this app to Cloudflare production');
  });

  test('waits for container readiness before signed-in production validation', async () => {
    vi.mocked(getAuthToken).mockReturnValue('user-session');
    const readFile = vi.fn();
    const spawn = vi.fn().mockRejectedValue(new Error('no deploy in unit test'));

    await expect(
      runDeploy({
        container: { fs: { readFile }, spawn } as unknown as WebContainer,
        abortSignal: new AbortController().signal,
        onOutput: vi.fn(),
        workspace: {
          hasFile: vi.fn(),
          setGeneratedFileContent: vi.fn(),
        },
      }),
    ).rejects.toThrow('no deploy in unit test');

    expect(waitForContainerBootState).toHaveBeenCalledOnce();
    expect(readFile).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith('pnpm', ['run', 'verify:stack'], undefined);
  });

  test('uploads an immutable snapshot for approval instead of running Wrangler in the browser', async () => {
    vi.mocked(getAuthToken).mockReturnValue('user-session');
    const spawn = vi.fn(async (_command: string, _args: string[]) => successfulProcess());
    const readFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
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
      container: { fs: { readFile }, spawn } as unknown as WebContainer,
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      workspace: { hasFile: vi.fn(), setGeneratedFileContent: vi.fn() },
    });

    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      ['run', 'verify:stack'],
      ['run', 'typecheck'],
      ['run', 'build'],
      ['run', 'lint'],
      [
        '-czf',
        '/tmp/ghostbuild-deployment.tar.gz',
        '--exclude=./node_modules',
        '--exclude=./dist',
        '--exclude=./.output',
        '--exclude=./.tanstack',
        '--exclude=./.wrangler',
        '--exclude=./.env',
        '--exclude=./.env.*',
        '--exclude=./.dev.vars',
        '--exclude=./.dev.vars.*',
        '--exclude=./.envrc',
        '.',
      ],
    ]);
    expect(readFile).toHaveBeenCalledWith('/tmp/ghostbuild-deployment.tar.gz');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/deployments/plan?chatId=chat-1',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    );
    expect(result).toContain('Deployment plan ready for your approval');
    expect(result).toContain('GHOSTBUILD_DEPLOYMENT_PLAN:');
    expect(result).not.toContain('wrangler deploy');
  });

  test('rejects a guest deploy when the starter app was not replaced', async () => {
    vi.mocked(getAuthToken).mockReturnValue('guest_00000000-0000-4000-8000-000000000000');
    const readFile = vi.fn().mockResolvedValue(`
      <p>Ghostbuild on Cloudflare</p>
      <h1>Start with a durable AI agent.</h1>
      <h2>App Agent</h2>
    `);

    await expect(
      runDeploy({
        container: { fs: { readFile }, spawn: vi.fn() } as unknown as WebContainer,
        abortSignal: new AbortController().signal,
        onOutput: vi.fn(),
        workspace: {
          hasFile: vi.fn(),
          setGeneratedFileContent: vi.fn(),
        },
      }),
    ).rejects.toThrow('Generated app route still matches the starter template');
  });
});

function successfulProcess(): WebContainerProcess {
  return {
    output: new ReadableStream({
      start(controller) {
        controller.enqueue('ok');
        controller.close();
      },
    }),
    exit: Promise.resolve(0),
    kill: vi.fn(),
  } as unknown as WebContainerProcess;
}

describe('runCommand cancellation', () => {
  test('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn();

    await expect(
      runCommand({
        container: { spawn } as unknown as WebContainer,
        command: ['pnpm', 'run', 'build'],
        abortSignal: controller.signal,
        commandErroredController: new AbortController(),
        onOutput: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(spawn).not.toHaveBeenCalled();
  });

  test('kills a process that resolves after the spawn timeout', async () => {
    vi.useFakeTimers();
    let resolveSpawn!: (process: WebContainerProcess) => void;
    const spawnPromise = new Promise<WebContainerProcess>((resolve) => {
      resolveSpawn = resolve;
    });
    const spawn = vi.fn(() => spawnPromise);
    const process = { kill: vi.fn() } as unknown as WebContainerProcess;

    const command = runCommand({
      container: { spawn } as unknown as WebContainer,
      command: ['pnpm', 'run', 'build'],
      abortSignal: new AbortController().signal,
      commandErroredController: new AbortController(),
      onOutput: vi.fn(),
      timeoutMs: 100,
    });
    const rejection = expect(command).rejects.toBeInstanceOf(ActionCommandTimeoutError);

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    resolveSpawn(process);
    await Promise.resolve();
    await Promise.resolve();

    expect(process.kill).toHaveBeenCalledOnce();
  });
});
