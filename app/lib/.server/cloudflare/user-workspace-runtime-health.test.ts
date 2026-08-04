import { describe, expect, it, vi } from 'vitest';
import {
  readUserWorkspaceRuntimeHealth,
  requireExpectedUserWorkspaceRuntimeHealth,
} from './user-workspace-runtime-health';

const runtimeVersion = 'a'.repeat(64);

describe('user workspace runtime health', () => {
  it('reports the deployed source identity only after D1 responds', async () => {
    const first = vi.fn().mockResolvedValue({ ok: 1 });
    const prepare = vi.fn(() => ({ first }));

    await expect(
      readUserWorkspaceRuntimeHealth({ DB: { prepare } as never, GHOSTBUILD_RUNTIME_VERSION: runtimeVersion }),
    ).resolves.toEqual({
      ok: true,
      service: 'ghostbuild-user-workspace-runtime',
      runtimeVersion,
    });

    expect(prepare).toHaveBeenCalledWith('SELECT 1 AS ok');
    expect(first).toHaveBeenCalledOnce();
  });

  it('fails readiness when the required D1 binding cannot be read', async () => {
    const prepare = vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) }));

    await expect(
      readUserWorkspaceRuntimeHealth({ DB: { prepare } as never, GHOSTBUILD_RUNTIME_VERSION: runtimeVersion }),
    ).rejects.toThrow('database is unavailable');
  });

  it('rejects a healthy response from any runtime version other than the one just deployed', () => {
    expect(() =>
      requireExpectedUserWorkspaceRuntimeHealth(
        { ok: true, service: 'ghostbuild-user-workspace-runtime', runtimeVersion: 'b'.repeat(64) },
        runtimeVersion,
      ),
    ).toThrow('did not pass its health check');

    expect(() =>
      requireExpectedUserWorkspaceRuntimeHealth(
        { ok: true, service: 'ghostbuild-user-workspace-runtime', runtimeVersion },
        runtimeVersion,
      ),
    ).not.toThrow();
  });
});
