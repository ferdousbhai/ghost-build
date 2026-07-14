import { describe, expect, it, vi } from 'vitest';
import {
  approveDeployment,
  DeploymentApprovalDigestMismatchError,
  DeploymentConnectionChangedError,
} from './deployment-repository';

const digest = 'a'.repeat(64);

describe('approveDeployment', () => {
  it('atomically binds approval to owner, connection, state, and digest', async () => {
    const updateRun = vi.fn(async () => ({ meta: { changes: 1 } }));
    const updateBind = vi.fn(() => ({ run: updateRun }));
    const selectFirst = vi.fn(async () => row());
    const db = database((query) =>
      query.startsWith('UPDATE') ? { bind: updateBind } : { bind: vi.fn(() => ({ first: selectFirst })) },
    );

    const approved = await approveDeployment({
      db,
      deploymentId: 'deployment-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      approvedDigest: digest,
      now: 100,
    });

    expect(updateBind).toHaveBeenCalledWith(digest, 100, 100, 'deployment-1', 'user-1', 'connection-1', digest);
    expect(approved.status).toBe('approved');
  });

  it('rejects approval when the reviewed digest no longer matches', async () => {
    const db = database((query) =>
      query.startsWith('UPDATE')
        ? { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) }
        : { bind: vi.fn(() => ({ first: vi.fn(async () => row({ plan_digest: 'b'.repeat(64) })) })) },
    );
    await expect(
      approveDeployment({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        approvedDigest: digest,
      }),
    ).rejects.toBeInstanceOf(DeploymentApprovalDigestMismatchError);
  });

  it('rejects approval after the Cloudflare connection changes', async () => {
    const db = database((query) =>
      query.startsWith('UPDATE')
        ? { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) }
        : { bind: vi.fn(() => ({ first: vi.fn(async () => row({ connection_id: 'connection-old' })) })) },
    );
    await expect(
      approveDeployment({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        approvedDigest: digest,
      }),
    ).rejects.toBeInstanceOf(DeploymentConnectionChangedError);
  });
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deployment-1',
    chat_id: 'chat-1',
    user_id: 'user-1',
    connection_id: 'connection-1',
    status: 'approved',
    plan_json: JSON.stringify({ version: 1, resources: [] }),
    plan_digest: digest,
    approved_digest: digest,
    approved_at: 100,
    production_url: null,
    error_code: null,
    error_message: null,
    created_at: 1,
    updated_at: 100,
    ...overrides,
  };
}

function database(prepare: (query: string) => unknown): D1Database {
  return { prepare: vi.fn(prepare) } as unknown as D1Database;
}
