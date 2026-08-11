import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_WORKSPACE_RUNTIME_GC_CRON } from '../../app/lib/.server/cloudflare/user-workspace-runtime-policy';
import { sweepAgentGcCandidatesBestEffort } from '../../app/lib/cloudflare/data/agent-gc.server';
import { sweepAppResourceGcCandidatesBestEffort } from '../../app/lib/cloudflare/data/app-resource-gc.server';
import { scheduleUserWorkspaceRuntimeMaintenance } from './scheduled-maintenance';

vi.mock('../../app/lib/cloudflare/data/agent-gc.server', () => ({
  sweepAgentGcCandidatesBestEffort: vi.fn(async () => undefined),
}));
vi.mock('../../app/lib/cloudflare/data/app-resource-gc.server', () => ({
  sweepAppResourceGcCandidatesBestEffort: vi.fn(async () => undefined),
}));

describe('user workspace runtime scheduled maintenance', () => {
  beforeEach(() => {
    vi.mocked(sweepAgentGcCandidatesBestEffort).mockClear();
    vi.mocked(sweepAppResourceGcCandidatesBestEffort).mockClear();
  });

  it('registers the agent-GC sweep for the exact provisioned cron', async () => {
    const waitUntil = vi.fn();
    const env = { BuilderAgent: {}, DB: {} } as unknown as Parameters<
      typeof scheduleUserWorkspaceRuntimeMaintenance
    >[1];

    expect(scheduleUserWorkspaceRuntimeMaintenance({ cron: USER_WORKSPACE_RUNTIME_GC_CRON }, env, { waitUntil })).toBe(
      true,
    );

    expect(sweepAgentGcCandidatesBestEffort).toHaveBeenCalledOnce();
    expect(sweepAgentGcCandidatesBestEffort).toHaveBeenCalledWith(env);
    expect(sweepAppResourceGcCandidatesBestEffort).toHaveBeenCalledOnce();
    expect(sweepAppResourceGcCandidatesBestEffort).toHaveBeenCalledWith(env);
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await expect(Promise.all(waitUntil.mock.calls.map(([promise]) => promise))).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it('ignores an unprovisioned trigger', () => {
    const waitUntil = vi.fn();

    expect(
      scheduleUserWorkspaceRuntimeMaintenance(
        { cron: '0 0 * * *' },
        { BuilderAgent: {}, DB: {} } as unknown as Parameters<typeof scheduleUserWorkspaceRuntimeMaintenance>[1],
        { waitUntil },
      ),
    ).toBe(false);

    expect(sweepAgentGcCandidatesBestEffort).not.toHaveBeenCalled();
    expect(sweepAppResourceGcCandidatesBestEffort).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
