import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DeploymentProjectProfile } from './deployment-snapshot';

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

const appAgentWebProject: DeploymentProjectProfile = {
  type: 'web_app',
  bindings: { ai: true, d1: true, r2: true, appAgent: true },
};

describe('buildDeploymentSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandbox.mkdir.mockResolvedValue({ success: true });
    sandbox.writeFile.mockResolvedValue({ success: true });
    sandbox.exec.mockImplementation(async (command: string) => ({
      success: true,
      exitCode: 0,
      stdout:
        command === 'command -v node'
          ? '/usr/local/bin/node\n'
          : command === 'command -v pnpm'
            ? '/usr/local/bin/pnpm\n'
            : command === 'sha256sum package.json pnpm-lock.yaml wrangler.jsonc pnpm-workspace.yaml'
              ? approvedInputDigestOutput()
              : '',
      stderr: '',
      command,
    }));
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
        project: appAgentWebProject,
      }),
    ).resolves.toEqual(new Uint8Array([9, 8, 7]));

    expect(sandbox.writeFile).toHaveBeenCalledWith('/workspace/source.zip', sourceBody);
    const commands = sandbox.exec.mock.calls.map((call) => call[0] as string);
    expect(commands[0]).toContain('/workspace/ghostbuild-approved-inputs');
    expect(commands).toContain('command -v node');
    expect(commands).toContain('command -v pnpm');
    expect(commands).toContain('sha256sum package.json pnpm-lock.yaml wrangler.jsonc pnpm-workspace.yaml');
    expect(commands).toContain(
      "'/usr/local/bin/pnpm' install --frozen-lockfile --ignore-scripts=true --ignore-pnpmfile --registry=https://registry.npmjs.org/",
    );
    const entrypoints = commands.filter(
      (command) =>
        command.includes("'/usr/local/bin/node'") && !command.includes('/workspace/ghostbuild-trusted-bin/node'),
    );
    expect(entrypoints).toHaveLength(8);
    for (const command of entrypoints) {
      expect(command).toContain(`sha256sum './package.json'`);
      expect(command).toContain(`sha256sum '/workspace/ghostbuild-approved-inputs/package.json'`);
    }
    expect(entrypoints[0]).toContain('/workspace/ghostbuild-approved-inputs/scripts/cf-typegen.mjs');
    expect(entrypoints.some((command) => command.includes(' scripts/cf-typegen.mjs'))).toBe(false);
    expect(commands.at(-5)).toContain(`sha256sum './package.json'`);
    expect(commands.at(-5)).toContain(`sha256sum '/workspace/ghostbuild-approved-inputs/package.json'`);
    expect(commands.at(-4)).toContain('cp -a /workspace/project/dist');
    expect(commands.at(-3)).toContain('du -sk --apparent-size /workspace/package');
    expect(commands.at(-2)).toContain('tar -czf /workspace/build.tar.gz');
    expect(commands.at(-1)).toContain('stat -c %s /workspace/build.tar.gz');
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

  test('does not let a Worker project label bypass AppAgent protected entrypoint gates', async () => {
    const env = {
      DeploymentSandbox: {},
      APP_STORAGE: { get: vi.fn(async () => ({ body: stream([1, 2, 3]) })) },
    } as unknown as Env;

    await expect(
      buildDeploymentSnapshot({
        env,
        deploymentId: 'deployment-1',
        snapshotKey: 'snapshots/1',
        expectedSourceSha256: 'a'.repeat(64),
        project: {
          type: 'worker',
          bindings: { ai: true, d1: true, r2: true, appAgent: true },
        },
      }),
    ).resolves.toEqual(new Uint8Array([9, 8, 7]));

    const commands = sandbox.exec.mock.calls.map((call) => call[0] as string);
    const entrypoints = commands.filter(
      (command) =>
        command.includes("'/usr/local/bin/node'") && !command.includes('/workspace/ghostbuild-trusted-bin/node'),
    );
    expect(entrypoints).toHaveLength(8);
    for (const command of entrypoints) {
      expect(command).toContain(`sha256sum './scripts/cf-typegen.mjs'`);
      expect(command).toContain(`sha256sum '/workspace/ghostbuild-approved-inputs/scripts/cf-typegen.mjs'`);
    }
    expect(commands.some((command) => command.includes("'/usr/local/bin/pnpm' run typecheck"))).toBe(false);
  });

  test('preserves the validated non-AppAgent Worker build path behind dual config gates', async () => {
    const env = {
      DeploymentSandbox: {},
      APP_STORAGE: { get: vi.fn(async () => ({ body: stream([1, 2, 3]) })) },
    } as unknown as Env;

    await expect(
      buildDeploymentSnapshot({
        env,
        deploymentId: 'deployment-1',
        snapshotKey: 'snapshots/1',
        expectedSourceSha256: 'a'.repeat(64),
        project: {
          type: 'worker',
          bindings: { ai: false, d1: false, r2: false, appAgent: false },
        },
      }),
    ).resolves.toEqual(new Uint8Array([9, 8, 7]));

    const commands = sandbox.exec.mock.calls.map((call) => call[0] as string);
    const entrypoints = commands.filter((command) => command.includes("'/usr/local/bin/pnpm' run "));
    expect(entrypoints).toHaveLength(4);
    for (const command of entrypoints) {
      expect(command).toContain(`sha256sum './package.json'`);
      expect(command).toContain(`sha256sum '/workspace/ghostbuild-approved-inputs/package.json'`);
      expect(command).not.toContain('scripts/cf-typegen.mjs');
    }
  });

  test('rejects an inconsistent Worker profile with unmediated Workers AI before sandbox execution', async () => {
    const env = {
      DeploymentSandbox: {},
      APP_STORAGE: { get: vi.fn(async () => ({ body: stream([1, 2, 3]) })) },
    } as unknown as Env;

    await expect(
      buildDeploymentSnapshot({
        env,
        deploymentId: 'deployment-1',
        snapshotKey: 'snapshots/1',
        expectedSourceSha256: 'a'.repeat(64),
        project: {
          type: 'worker',
          bindings: { ai: true, d1: false, r2: false, appAgent: false },
        },
      }),
    ).rejects.toThrow('Approved deployment profile contains an unmediated Workers AI binding.');

    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  test('fails closed and destroys the sandbox when a command fails', async () => {
    sandbox.exec.mockImplementation(async (command: string) => {
      if (command === 'command -v node') {
        return { success: true, exitCode: 0, stdout: '/usr/local/bin/node\n', stderr: '', command };
      }
      if (command === 'command -v pnpm') {
        return { success: true, exitCode: 0, stdout: '/usr/local/bin/pnpm\n', stderr: '', command };
      }
      if (command.includes('sha256sum /workspace/source.zip')) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: 'invalid archive',
          command,
        };
      }
      return { success: true, exitCode: 0, stdout: '', stderr: '', command };
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
        project: appAgentWebProject,
      }),
    ).rejects.toThrow('failed during source extraction: Production build command failed (1): invalid archive');
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('records the failing build stage and nested Sandbox transport error', async () => {
    sandbox.exec.mockImplementation(async (command: string) => {
      if (command === 'command -v node') {
        return { success: true, exitCode: 0, stdout: '/usr/local/bin/node\n', stderr: '', command };
      }
      if (command === 'command -v pnpm') {
        return { success: true, exitCode: 0, stdout: '/usr/local/bin/pnpm\n', stderr: '', command };
      }
      if (command === 'sha256sum package.json pnpm-lock.yaml wrangler.jsonc pnpm-workspace.yaml') {
        return { success: true, exitCode: 0, stdout: approvedInputDigestOutput(), stderr: '', command };
      }
      if (command.startsWith("'/usr/local/bin/pnpm' install ")) {
        throw new Error('Sandbox RPC connection closed.', {
          cause: new Error('Command timed out after 600000ms.'),
        });
      }
      return { success: true, exitCode: 0, stdout: '', stderr: '', command };
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
        project: appAgentWebProject,
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
    sandbox.exec.mockImplementation(async (command: string) => {
      if (command === 'command -v node') {
        return { success: true, exitCode: 0, stdout: '/usr/local/bin/node\n', stderr: '', command };
      }
      if (command === 'command -v pnpm') {
        return { success: true, exitCode: 0, stdout: '/usr/local/bin/pnpm\n', stderr: '', command };
      }
      return command === 'ghostbuild-verify-pnpm-workspace pnpm-workspace.yaml'
        ? {
            success: false,
            exitCode: 1,
            stdout: '',
            stderr: 'pnpm-workspace.yaml allowBuilds must not approve unexpected package malicious-installer.',
            command,
          }
        : { success: true, exitCode: 0, stdout: '', stderr: '', command };
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
        project: appAgentWebProject,
      }),
    ).rejects.toThrow(
      'failed during workspace policy verification: Production build command failed (1): pnpm-workspace.yaml allowBuilds must not approve unexpected package malicious-installer.',
    );
    expect(sandbox.exec.mock.calls.map((call) => call[0])).not.toContain(
      "'/usr/local/bin/pnpm' install --frozen-lockfile --ignore-scripts=true --ignore-pnpmfile --registry=https://registry.npmjs.org/",
    );
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('rejects a modified protected config before the first project entrypoint executes', async () => {
    sandbox.exec.mockImplementation(async (command: string) => {
      if (command === 'command -v node') {
        return { success: true, exitCode: 0, stdout: '/usr/local/bin/node\n', stderr: '', command };
      }
      if (command === 'command -v pnpm') {
        return { success: true, exitCode: 0, stdout: '/usr/local/bin/pnpm\n', stderr: '', command };
      }
      if (command === 'sha256sum package.json pnpm-lock.yaml wrangler.jsonc pnpm-workspace.yaml') {
        return { success: true, exitCode: 0, stdout: approvedInputDigestOutput(), stderr: '', command };
      }
      if (command.startsWith(`test "$(sha256sum './package.json'`) && command.includes("'/usr/local/bin/node'")) {
        return { success: false, exitCode: 1, stdout: '', stderr: 'vite.config.ts changed', command };
      }
      return { success: true, exitCode: 0, stdout: '', stderr: '', command };
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
        project: appAgentWebProject,
      }),
    ).rejects.toThrow('failed during type checking');
    expect(
      sandbox.exec.mock.calls.some(
        (call) =>
          call[0].includes('/workspace/ghostbuild-approved-inputs/scripts/cf-typegen.mjs') &&
          call[0].startsWith(`test "$(sha256sum './package.json'`),
      ),
    ).toBe(true);
    expect(sandbox.exec.mock.calls.some((call) => call[0].startsWith('cp -a /workspace/project/dist'))).toBe(false);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('rejects a restore attempt when the immutable trusted verifier copy differs', async () => {
    sandbox.exec.mockImplementation(async (command: string) => {
      if (command === 'command -v node') {
        return { success: true, exitCode: 0, stdout: '/usr/local/bin/node\n', stderr: '', command };
      }
      if (command === 'command -v pnpm') {
        return { success: true, exitCode: 0, stdout: '/usr/local/bin/pnpm\n', stderr: '', command };
      }
      if (command === 'sha256sum package.json pnpm-lock.yaml wrangler.jsonc pnpm-workspace.yaml') {
        return { success: true, exitCode: 0, stdout: approvedInputDigestOutput(), stderr: '', command };
      }
      if (
        command.includes(`sha256sum '/workspace/ghostbuild-approved-inputs/scripts/cf-typegen.mjs'`) &&
        command.includes("'/usr/local/bin/node'")
      ) {
        return { success: false, exitCode: 1, stdout: '', stderr: 'trusted verifier changed', command };
      }
      return { success: true, exitCode: 0, stdout: '', stderr: '', command };
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
        project: appAgentWebProject,
      }),
    ).rejects.toThrow('failed during type checking');
    expect(sandbox.exec.mock.calls.some((call) => call[0].startsWith('cp -a /workspace/project/dist'))).toBe(false);
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
        project: appAgentWebProject,
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

function approvedInputDigestOutput(): string {
  return [
    `${'1'.repeat(64)}  package.json`,
    `${'2'.repeat(64)}  pnpm-lock.yaml`,
    `${'3'.repeat(64)}  wrangler.jsonc`,
    `${'4'.repeat(64)}  pnpm-workspace.yaml`,
  ].join('\n');
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
