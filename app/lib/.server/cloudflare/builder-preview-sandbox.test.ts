import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSandbox = vi.hoisted(() => vi.fn());
const runBoundedDeploymentBuildCommand = vi.hoisted(() => vi.fn());

vi.mock('@cloudflare/sandbox', () => ({ getSandbox }));
vi.mock('./deployment-build-executor', () => ({ runBoundedDeploymentBuildCommand }));

import { buildBuilderPreview } from './builder-preview-sandbox';

describe('buildBuilderPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runBoundedDeploymentBuildCommand.mockResolvedValue(success());
  });

  it('builds an immutable R2 snapshot with the static preview config and no plaintext credentials', async () => {
    const commands: Array<{ command: string; options?: Record<string, unknown> }> = [];
    const waitForPort = vi.fn().mockResolvedValue(undefined);
    const sandbox = {
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn(async (command: string, options?: Record<string, unknown>) => {
        commands.push({ command, options });
        if (command === 'command -v node') {
          return success('/usr/bin/node\n');
        }
        if (command === 'command -v pnpm') {
          return success('/usr/local/bin/pnpm\n');
        }
        return success();
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      killAllProcesses: vi.fn().mockResolvedValue(undefined),
      startProcess: vi.fn().mockResolvedValue({ waitForPort }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    getSandbox.mockReturnValue(sandbox);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const previewBasePath = '/api/previews/123e4567-e89b-42d3-a456-426614174000/token/';

    await buildBuilderPreview({
      env: {
        APP_STORAGE: { get: vi.fn().mockResolvedValue({ body: source }) },
        DeploymentSandbox: {},
      } as never,
      sandboxId: 'sandbox-a',
      snapshotKey: 'builder-previews/snapshot.zip',
      previewBasePath,
    });

    expect(sandbox.writeFile).toHaveBeenCalledWith('/workspace/preview-source.zip', source);
    expect(runBoundedDeploymentBuildCommand).toHaveBeenCalledTimes(3);
    expect(runBoundedDeploymentBuildCommand.mock.calls[2]?.[1]).toContain(
      `vite build --config vite.preview.config.mjs --base '${previewBasePath}'`,
    );
    const buildOptions = runBoundedDeploymentBuildCommand.mock.calls[2]?.[2] as {
      env: Record<string, string>;
    };
    expect(buildOptions.env).toEqual({
      PATH: '/workspace/preview-trusted-bin:/usr/bin:/usr/bin:/bin',
      NODE_ENV: 'production',
    });
    expect(JSON.stringify(buildOptions.env)).not.toMatch(/token|secret|credential|api[_-]?key/i);
    expect(sandbox.startProcess.mock.calls[0]?.[0]).toContain('vite preview --config vite.preview.config.mjs');
    expect(waitForPort).toHaveBeenCalledWith(4173, expect.objectContaining({ mode: 'http' }));
    expect(sandbox.setKeepAlive).toHaveBeenLastCalledWith(true);
  });

  it('destroys the isolated sandbox after a failed build', async () => {
    const sandbox = {
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue({ ...success(), success: false, stderr: 'unzip failed' }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    getSandbox.mockReturnValue(sandbox);

    await expect(
      buildBuilderPreview({
        env: {
          APP_STORAGE: { get: vi.fn().mockResolvedValue({ body: new ReadableStream() }) },
          DeploymentSandbox: {},
        } as never,
        sandboxId: 'sandbox-a',
        snapshotKey: 'builder-previews/snapshot.zip',
        previewBasePath: '/api/previews/id/token/',
      }),
    ).rejects.toThrow('unzip failed');
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });
});

function success(stdout = '') {
  return {
    success: true,
    exitCode: 0,
    stdout,
    stderr: '',
    command: '',
    duration: 1,
    timestamp: new Date(0).toISOString(),
  };
}
