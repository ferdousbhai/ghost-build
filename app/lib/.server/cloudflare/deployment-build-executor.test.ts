import { beforeEach, describe, expect, test, vi } from 'vitest';

const sandbox = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  exec: vi.fn(),
  killAllProcesses: vi.fn(),
  readFileStream: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn(() => sandbox) }));

import { buildDeploymentSnapshot, DEPLOYMENT_BUILD_STEP_BUDGET_MS } from './deployment-build-executor';

describe('buildDeploymentSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandbox.mkdir.mockResolvedValue({ success: true });
    sandbox.writeFile.mockResolvedValue({ success: true });
    sandbox.exec.mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'command' });
    sandbox.killAllProcesses.mockResolvedValue(0);
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
      buildDeploymentSnapshot({
        env,
        deploymentId: 'deployment-1',
        snapshotKey: 'snapshots/1',
        expectedSourceSha256: 'a'.repeat(64),
      }),
    ).resolves.toEqual(new Uint8Array([9, 8, 7]));

    expect(sandbox.writeFile).toHaveBeenCalledWith('/workspace/source.zip', sourceBody);
    expect(sandbox.exec.mock.calls.map((call) => call[0])).toEqual([
      'rm -rf /workspace/project /workspace/source /workspace/source.zip /workspace/build.tar.gz /workspace/package',
      `test "$(sha256sum /workspace/source.zip | cut -d ' ' -f1)" = "${'a'.repeat(64)}"`,
      `test "$(unzip -p /workspace/source.zip | head -c 262144001 | wc -c | tr -d ' ')" -le 262144000`,
      'unzip -q /workspace/source.zip -d /workspace/source',
      'test "$(du -sk /workspace/source | cut -f1)" -le 256000',
      'if [ -f /workspace/source/package.json ]; then cp -a /workspace/source/. /workspace/project/; elif [ -f /workspace/source/project/package.json ]; then cp -a /workspace/source/project/. /workspace/project/; else echo "Deployment snapshot does not contain package.json" >&2; exit 1; fi',
      'ghostbuild-verify-pnpm-workspace pnpm-workspace.yaml',
      'pnpm install --frozen-lockfile --ignore-scripts=false --ignore-pnpmfile --registry=https://registry.npmjs.org/',
      'pnpm run typecheck',
      'pnpm run verify:stack',
      'pnpm run build',
      'pnpm run lint',
      'cp -a /workspace/project/dist /workspace/project/package.json /workspace/project/pnpm-lock.yaml /workspace/package/ && if [ -d /workspace/project/migrations ]; then cp -a /workspace/project/migrations /workspace/package/; fi',
      'test "$(du -sk --apparent-size /workspace/package | cut -f1)" -le 307200 && test -z "$(find /workspace/package -type l -print -quit)"',
      'tar -czf /workspace/build.tar.gz -C /workspace/package .',
      'test "$(stat -c %s /workspace/build.tar.gz)" -le 52428800',
    ]);
    expect(sandbox.exec.mock.calls.some((call) => JSON.stringify(call).includes('token'))).toBe(false);
    expect(sandbox.mkdir).toHaveBeenNthCalledWith(1, '/workspace/project', { recursive: true });
    expect(sandbox.mkdir).toHaveBeenNthCalledWith(2, '/workspace/source', { recursive: true });
    expect(sandbox.mkdir).toHaveBeenNthCalledWith(3, '/workspace/package', { recursive: true });
    expect(sandbox.killAllProcesses).toHaveBeenCalledOnce();
    expect(sandbox.killAllProcesses.mock.invocationCallOrder[0]).toBeLessThan(
      sandbox.mkdir.mock.invocationCallOrder[2],
    );
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('fails closed and destroys the sandbox when a command fails', async () => {
    sandbox.exec
      .mockResolvedValueOnce({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'reset' })
      .mockResolvedValueOnce({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'invalid archive',
        command: 'digest',
      });
    const env = {
      DeploymentSandbox: {},
      APP_STORAGE: { get: vi.fn(async () => ({ body: stream([1]) })) },
    } as unknown as Env;

    await expect(
      buildDeploymentSnapshot({
        env,
        deploymentId: 'deployment-1',
        snapshotKey: 'snapshots/1',
        expectedSourceSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow('failed during source extraction: Production build command failed (1): invalid archive');
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('records the failing build stage and nested Sandbox transport error', async () => {
    sandbox.exec
      .mockResolvedValueOnce({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'reset' })
      .mockResolvedValueOnce({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'digest' })
      .mockResolvedValueOnce({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'preflight' })
      .mockResolvedValueOnce({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'unzip' })
      .mockResolvedValueOnce({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'size' })
      .mockResolvedValueOnce({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'copy' })
      .mockResolvedValueOnce({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'policy' })
      .mockRejectedValueOnce(
        new Error('Sandbox RPC connection closed.', {
          cause: new Error('Command timed out after 600000ms.'),
        }),
      );
    const env = {
      DeploymentSandbox: {},
      APP_STORAGE: { get: vi.fn(async () => ({ body: stream([1]) })) },
    } as unknown as Env;

    await expect(
      buildDeploymentSnapshot({
        env,
        deploymentId: 'deployment-1',
        snapshotKey: 'snapshots/1',
        expectedSourceSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(
      'failed during dependency installation: Sandbox RPC connection closed. Caused by: Command timed out after 600000ms.',
    );
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('keeps the aggregate explicit build budget below 25 minutes of a 30-minute Workflow step', () => {
    expect(DEPLOYMENT_BUILD_STEP_BUDGET_MS).toBeLessThanOrEqual(25 * 60 * 1000);
  });

  test('rejects an unsafe workspace policy before dependency installation', async () => {
    sandbox.exec.mockImplementation(async (command: string) =>
      command === 'ghostbuild-verify-pnpm-workspace pnpm-workspace.yaml'
        ? {
            success: false,
            exitCode: 1,
            stdout: '',
            stderr: 'pnpm-workspace.yaml allowBuilds must not approve unexpected package malicious-installer.',
            command,
          }
        : { success: true, exitCode: 0, stdout: '', stderr: '', command },
    );
    const env = {
      DeploymentSandbox: {},
      APP_STORAGE: { get: vi.fn(async () => ({ body: stream([1]) })) },
    } as unknown as Env;

    await expect(
      buildDeploymentSnapshot({
        env,
        deploymentId: 'deployment-1',
        snapshotKey: 'snapshots/1',
        expectedSourceSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(
      'failed during workspace policy verification: Production build command failed (1): pnpm-workspace.yaml allowBuilds must not approve unexpected package malicious-installer.',
    );
    expect(sandbox.exec.mock.calls.map((call) => call[0])).not.toContain(
      'pnpm install --frozen-lockfile --ignore-scripts=false --ignore-pnpmfile --registry=https://registry.npmjs.org/',
    );
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('rejects bytes emitted beyond the checked build archive limit', async () => {
    sandbox.readFileStream.mockResolvedValue(oversizedBuildStream());
    const env = {
      DeploymentSandbox: {},
      APP_STORAGE: { get: vi.fn(async () => ({ body: stream([1]) })) },
    } as unknown as Env;

    await expect(
      buildDeploymentSnapshot({
        env,
        deploymentId: 'deployment-1',
        snapshotKey: 'snapshots/1',
        expectedSourceSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow('build archive exceeds the download size limit');
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

function oversizedBuildStream(): ReadableStream<Uint8Array> {
  const oneMib = new Uint8Array(1024 * 1024);
  let emittedMib = 0;
  return new ReadableStream({
    pull(controller) {
      if (emittedMib < 50) {
        emittedMib += 1;
        controller.enqueue(oneMib);
        return;
      }
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
}
