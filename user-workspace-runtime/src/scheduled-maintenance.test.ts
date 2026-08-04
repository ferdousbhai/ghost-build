import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_WORKSPACE_RUNTIME_GC_CRON } from '../../app/lib/.server/cloudflare/user-workspace-runtime-policy';
import { sweepAgentGcCandidatesBestEffort } from '../../app/lib/cloudflare/data/agent-gc.server';
import { scheduleUserWorkspaceRuntimeMaintenance } from './scheduled-maintenance';

vi.mock('../../app/lib/cloudflare/data/agent-gc.server', () => ({
  sweepAgentGcCandidatesBestEffort: vi.fn(async () => undefined),
}));

describe('user workspace runtime scheduled maintenance', () => {
  beforeEach(() => {
    vi.mocked(sweepAgentGcCandidatesBestEffort).mockClear();
  });

  it('registers the agent-GC sweep for the exact provisioned cron', async () => {
    const waitUntil = vi.fn();
    const env = { BuilderAgent: {}, DB: {} } as unknown as Pick<Env, 'BuilderAgent' | 'DB'>;

    expect(scheduleUserWorkspaceRuntimeMaintenance({ cron: USER_WORKSPACE_RUNTIME_GC_CRON }, env, { waitUntil })).toBe(
      true,
    );

    expect(sweepAgentGcCandidatesBestEffort).toHaveBeenCalledOnce();
    expect(sweepAgentGcCandidatesBestEffort).toHaveBeenCalledWith(env);
    expect(waitUntil).toHaveBeenCalledOnce();
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
  });

  it('ignores an unprovisioned trigger', () => {
    const waitUntil = vi.fn();

    expect(
      scheduleUserWorkspaceRuntimeMaintenance(
        { cron: '0 0 * * *' },
        { BuilderAgent: {}, DB: {} } as unknown as Pick<Env, 'BuilderAgent' | 'DB'>,
        { waitUntil },
      ),
    ).toBe(false);

    expect(sweepAgentGcCandidatesBestEffort).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
