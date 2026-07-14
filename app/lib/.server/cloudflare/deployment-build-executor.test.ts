import { beforeEach, describe, expect, test, vi } from 'vitest';

const sandbox = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  exec: vi.fn(),
  readFileStream: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn(() => sandbox) }));

import { buildDeploymentSnapshot, DeploymentBuildError } from './deployment-build-executor';

describe('buildDeploymentSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandbox.mkdir.mockResolvedValue({ success: true });
    sandbox.writeFile.mockResolvedValue({ success: true });
    sandbox.exec.mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'command' });
    sandbox.readFileStream.mockResolvedValue(stream([9, 8, 7]));
    sandbox.destroy.mockResolvedValue(undefined);
  });

  test('rebuilds an R2 snapshot without passing a Cloudflare credential into the sandbox', async () => {
    const sourceBody = stream([1, 2, 3]);
    const env = {
      DeploymentSandbox: {},
      APP_STORAGE: { get: vi.fn(async () => ({ body: sourceBody })) },
    } as unknown as Env;

    await expect(
      buildDeploymentSnapshot({ env, deploymentId: 'deployment-1', snapshotKey: 'snapshots/1' }),
    ).resolves.toEqual(new Uint8Array([9, 8, 7]));

    expect(sandbox.writeFile).toHaveBeenCalledWith('/workspace/source.tar.gz', sourceBody);
    expect(sandbox.exec.mock.calls.map((call) => call[0])).toEqual([
      'tar -xzf /workspace/source.tar.gz -C /workspace/project',
      'pnpm install --frozen-lockfile --ignore-scripts=false',
      'pnpm run verify:stack',
      'pnpm run typecheck',
      'pnpm run build',
      'pnpm run lint',
      'tar -czf /workspace/build.tar.gz -C /workspace/project dist migrations package.json pnpm-lock.yaml',
    ]);
    expect(sandbox.exec.mock.calls.some((call) => JSON.stringify(call).includes('token'))).toBe(false);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('fails closed and destroys the sandbox when a command fails', async () => {
    sandbox.exec.mockResolvedValueOnce({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'invalid archive',
      command: 'tar',
    });
    const env = {
      DeploymentSandbox: {},
      APP_STORAGE: { get: vi.fn(async () => ({ body: stream([1]) })) },
    } as unknown as Env;

    await expect(
      buildDeploymentSnapshot({ env, deploymentId: 'deployment-1', snapshotKey: 'snapshots/1' }),
    ).rejects.toBeInstanceOf(DeploymentBuildError);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });
});

function stream(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}
