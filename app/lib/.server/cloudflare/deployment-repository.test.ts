import { describe, expect, it, vi } from 'vitest';
import {
  approveDeployment,
  claimApprovedDeployment,
  claimOldestReplaceableDeploymentSnapshot,
  DeploymentApprovalDigestMismatchError,
  DeploymentConcurrencyLimitError,
  DeploymentConnectionChangedError,
  DeploymentStateConflictError,
  prepareDeploymentRetry,
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
      connectionGeneration: 1,
      approvedDigest: digest,
      now: 100,
    });

    expect(updateBind).toHaveBeenCalledWith(digest, 100, 100, 'deployment-1', 'user-1', 'connection-1', 1, digest);
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
        connectionGeneration: 1,
        approvedDigest: digest,
      }),
    ).rejects.toBeInstanceOf(DeploymentApprovalDigestMismatchError);
  });

  it('rejects approval after the Cloudflare connection changes', async () => {
    const db = database((query) =>
      query.startsWith('UPDATE')
        ? { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) }
        : { bind: vi.fn(() => ({ first: vi.fn(async () => row({ connection_generation: 0 })) })) },
    );
    await expect(
      approveDeployment({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        approvedDigest: digest,
      }),
    ).rejects.toBeInstanceOf(DeploymentConnectionChangedError);
  });
});

describe('deployment retry and concurrency', () => {
  it('does not release a snapshot that became approved after replacement selection', async () => {
    const db = database((query) =>
      query.startsWith('SELECT id, snapshot_key')
        ? {
            bind: vi.fn(() => ({
              first: vi.fn(async () => ({ id: 'deployment-1', snapshot_key: 'snapshot-1' })),
            })),
          }
        : { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) },
    );
    await expect(claimOldestReplaceableDeploymentSnapshot({ db, userId: 'user-1' })).resolves.toBeNull();
  });

  it('allows only one active build or publish per user', async () => {
    const db = database((query) => {
      if (query.startsWith('UPDATE')) {
        return { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) };
      }
      if (query.includes("status IN ('provisioning', 'building', 'deploying')")) {
        return { bind: vi.fn(() => ({ first: vi.fn(async () => ({ id: 'deployment-other' })) })) };
      }
      if (query.includes('FROM cloudflare_connections')) {
        return { bind: vi.fn(() => ({ first: vi.fn(async () => ({ connection_generation: 1, status: 'active' })) })) };
      }
      return { bind: vi.fn(() => ({ first: vi.fn(async () => row()) })) };
    });
    await expect(
      claimApprovedDeployment({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
      }),
    ).rejects.toBeInstanceOf(DeploymentConcurrencyLimitError);
  });

  it('keeps a lost concurrency race retryable when the other deployment just finished', async () => {
    const db = database((query) => {
      if (query.startsWith('UPDATE')) {
        return { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) };
      }
      if (query.includes("status IN ('provisioning', 'building', 'deploying')")) {
        return { bind: vi.fn(() => ({ first: vi.fn(async () => null) })) };
      }
      if (query.includes('FROM cloudflare_connections')) {
        return { bind: vi.fn(() => ({ first: vi.fn(async () => ({ connection_generation: 1, status: 'active' })) })) };
      }
      return { bind: vi.fn(() => ({ first: vi.fn(async () => row()) })) };
    });
    await expect(
      claimApprovedDeployment({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
      }),
    ).rejects.toBeInstanceOf(DeploymentConcurrencyLimitError);
  });

  it('reopens the same immutable deployment plan for an approved retry', async () => {
    const db = database((query) =>
      query.startsWith('UPDATE')
        ? { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 1 } })) })) }
        : {
            bind: vi.fn(() => ({
              first: vi.fn(async () => row({ status: 'awaiting_approval' })),
            })),
          },
    );
    const retry = await prepareDeploymentRetry({
      db,
      deploymentId: 'deployment-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 1,
      now: 200,
    });
    expect(retry.id).toBe('deployment-1');
    expect(retry.status).toBe('awaiting_approval');
  });

  it('does not reopen a snapshot claimed for release', async () => {
    const db = database((query) =>
      query.startsWith('UPDATE')
        ? { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) }
        : {
            bind: vi.fn(() => ({
              first: vi.fn(async () => row({ status: 'canceled', error_code: 'deployment_snapshot_released' })),
            })),
          },
    );
    await expect(
      prepareDeploymentRetry({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
      }),
    ).rejects.toBeInstanceOf(DeploymentStateConflictError);
  });
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deployment-1',
    chat_id: 'chat-1',
    user_id: 'user-1',
    connection_id: 'connection-1',
    connection_generation: 1,
    snapshot_key: 'snapshot-1',
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
