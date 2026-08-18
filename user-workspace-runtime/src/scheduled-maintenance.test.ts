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

// Every job the provisioned trigger must register. Listing them here is what
// keeps the call-count assertions from drifting when a sweep is added.
const MAINTENANCE_JOBS = [sweepAgentGcCandidatesBestEffort, sweepAppResourceGcCandidatesBestEffort];

function maintenanceEnv() {
  return { BuilderAgent: {}, DB: {} } as unknown as Parameters<typeof scheduleUserWorkspaceRuntimeMaintenance>[1];
}

describe('user workspace runtime scheduled maintenance', () => {
  beforeEach(() => {
    for (const job of MAINTENANCE_JOBS) {
      vi.mocked(job).mockClear();
    }
  });

  it('registers every maintenance job for the exact provisioned cron', async () => {
    const waitUntil = vi.fn();
    const env = maintenanceEnv();

    expect(scheduleUserWorkspaceRuntimeMaintenance({ cron: USER_WORKSPACE_RUNTIME_GC_CRON }, env, { waitUntil })).toBe(
      true,
    );

    for (const job of MAINTENANCE_JOBS) {
      expect(job).toHaveBeenCalledOnce();
      expect(job).toHaveBeenCalledWith(env);
    }
    expect(waitUntil).toHaveBeenCalledTimes(MAINTENANCE_JOBS.length);
    await Promise.all(waitUntil.mock.calls.map(([promise]) => promise));
  });

  it('ignores an unprovisioned trigger', () => {
    const waitUntil = vi.fn();

    expect(scheduleUserWorkspaceRuntimeMaintenance({ cron: '0 0 * * *' }, maintenanceEnv(), { waitUntil })).toBe(false);

    for (const job of MAINTENANCE_JOBS) {
      expect(job).not.toHaveBeenCalled();
    }
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
