import { describe, expect, it, vi } from 'vitest';
import type { DeploymentPlan } from './deployment-plan';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from './deployment-security-baseline';
import {
  adoptLegacyApprovedDeploymentExecutionGeneration,
  approveDeployment,
  claimApprovedDeployment,
  claimOldestReplaceableDeploymentSnapshot,
  createDeployment,
  DeploymentApprovalDigestMismatchError,
  DeploymentConcurrencyLimitError,
  DeploymentConnectionChangedError,
  DeploymentSnapshotLimitError,
  DeploymentStateConflictError,
  prepareDeploymentRetry,
  reconcileStaleActiveDeployments,
  retainDeploymentBuildArtifactReference,
  transitionDeployment,
  type Deployment,
} from './deployment-repository';

const digest = 'a'.repeat(64);
const testPlan: DeploymentPlan = {
  version: 2,
  deploymentId: 'deployment-1',
  sourceSha256: 'b'.repeat(64),
  templateSourceSha256: TEMPLATE_SOURCE_SHA256,
  securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
  securityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
  project: { type: 'worker', bindings: { ai: false, d1: false, r2: false, appAgent: false } },
  billing: {
    infrastructure: 'user_cloudflare_account',
    workersAi: 'user_cloudflare_account',
    workersPaidUpgrade: 'explicit_user_authorization_required',
  },
  resources: [],
};

describe('createDeployment', () => {
  it('reconciles the exact committed snapshot when the D1 insert acknowledgement is lost', async () => {
    const insertError = new Error('D1 acknowledgement lost');
    const insertRun = vi.fn(async () => {
      throw insertError;
    });
    const committed = row({
      status: 'awaiting_approval',
      approved_digest: null,
      approved_at: null,
      execution_generation: 0,
    });
    const lookupFirst = vi.fn(async () => committed);
    const lookupBind = vi.fn(() => ({ first: lookupFirst }));
    const db = database((query) =>
      query.startsWith('INSERT INTO deployments') ? { bind: vi.fn(() => ({ run: insertRun })) } : { bind: lookupBind },
    );

    await expect(
      createDeployment({
        db,
        id: 'deployment-1',
        chatId: 'chat-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        snapshotKey: 'snapshot-1',
        plan: testPlan,
        planDigest: digest,
        now: 100,
      }),
    ).resolves.toMatchObject({
      id: 'deployment-1',
      executionGeneration: 0,
      snapshotKey: 'snapshot-1',
      planDigest: digest,
    });

    expect(insertRun).toHaveBeenCalledOnce();
    expect(db.prepare).toHaveBeenLastCalledWith(expect.stringContaining('snapshot_key = ? AND plan_digest = ?'));
    expect(lookupBind).toHaveBeenCalledWith('deployment-1', 'user-1', 'snapshot-1', digest);
  });

  it('preserves a real quota failure when no exact snapshot commit exists', async () => {
    const db = database((query) =>
      query.startsWith('INSERT INTO deployments')
        ? { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) }
        : { bind: vi.fn(() => ({ first: vi.fn(async () => null) })) },
    );

    await expect(
      createDeployment({
        db,
        id: 'deployment-1',
        chatId: 'chat-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        snapshotKey: 'snapshot-1',
        plan: testPlan,
        planDigest: digest,
      }),
    ).rejects.toBeInstanceOf(DeploymentSnapshotLimitError);
  });
});

describe('approveDeployment', () => {
  it('atomically binds approval to owner, connection, state, and digest', async () => {
    const updateRun = vi.fn(async () => ({ meta: { changes: 1 } }));
    const updateBind = vi.fn(() => ({ run: updateRun }));
    let deploymentRead = 0;
    const selectFirst = vi.fn(async () =>
      deploymentRead++ === 0
        ? row({
            status: 'awaiting_approval',
            execution_generation: 1,
            approved_digest: null,
            approved_at: null,
            build_artifact_key: null,
            build_artifact_generation: null,
            updated_at: 90,
          })
        : row({
            execution_generation: 2,
            build_artifact_key: null,
            build_artifact_generation: null,
            updated_at: 100,
          }),
    );
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

    expect(updateBind).toHaveBeenCalledWith(
      digest,
      100,
      100,
      'deployment-1',
      'user-1',
      'connection-1',
      1,
      1,
      'awaiting_approval',
      90,
      digest,
      'snapshot-1',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('execution_generation = execution_generation + 1'));
    expect(approved.status).toBe('approved');
    expect(approved.executionGeneration).toBe(2);
  });

  it('reconciles a lost approval acknowledgement from the exact committed generation', async () => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    let deploymentRead = 0;
    const db = database((query) => {
      if (query.startsWith('SELECT id, chat_id')) {
        const value =
          deploymentRead++ === 0
            ? row({
                status: 'awaiting_approval',
                approved_digest: null,
                approved_at: null,
                build_artifact_key: null,
                build_artifact_generation: null,
                updated_at: 90,
              })
            : row({
                status: 'approved',
                execution_generation: 2,
                approved_digest: digest,
                approved_at: 100,
                build_artifact_key: null,
                build_artifact_generation: null,
                updated_at: 100,
              });
        return { bind: vi.fn(() => ({ first: vi.fn(async () => value) })) };
      }
      return { bind: vi.fn(() => ({ run: vi.fn(async () => Promise.reject(acknowledgementError)) })) };
    });

    await expect(
      approveDeployment({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        approvedDigest: digest,
        now: 100,
      }),
    ).resolves.toMatchObject({ status: 'approved', executionGeneration: 2, approvedAt: 100, updatedAt: 100 });
    expect(deploymentRead).toBe(2);
  });

  it.each([
    ['a competing generation', { execution_generation: 3 }],
    ['a later state', { status: 'provisioning' }],
    ['a changed approval timestamp', { approved_at: 101 }],
    ['a changed checkpoint timestamp', { updated_at: 101 }],
    ['a changed connection', { connection_generation: 2 }],
    ['a changed plan', { plan_digest: 'b'.repeat(64) }],
    ['a replaced snapshot', { snapshot_key: 'snapshot-2' }],
    ['a competing artifact reference', { build_artifact_key: 'other-build', build_artifact_generation: 2 }],
    ['a changed outcome', { error_message: 'later outcome' }],
  ])('preserves the approval error when reconciliation observes %s', async (_label, latestOverrides) => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    let deploymentRead = 0;
    const db = database((query) => {
      if (query.startsWith('SELECT id, chat_id')) {
        const value =
          deploymentRead++ === 0
            ? row({
                status: 'awaiting_approval',
                approved_digest: null,
                approved_at: null,
                build_artifact_key: null,
                build_artifact_generation: null,
                updated_at: 90,
              })
            : row({
                status: 'approved',
                execution_generation: 2,
                approved_digest: digest,
                approved_at: 100,
                build_artifact_key: null,
                build_artifact_generation: null,
                updated_at: 100,
                ...latestOverrides,
              });
        return { bind: vi.fn(() => ({ first: vi.fn(async () => value) })) };
      }
      return { bind: vi.fn(() => ({ run: vi.fn(async () => Promise.reject(acknowledgementError)) })) };
    });

    await expect(
      approveDeployment({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        approvedDigest: digest,
        now: 100,
      }),
    ).rejects.toBe(acknowledgementError);
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

describe('legacy approved deployment execution generation', () => {
  it('atomically adopts the exact generation-zero approval as generation one', async () => {
    const updateBind = vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 1 } })) }));
    const db = database(() => ({ bind: updateBind }));
    const legacy = deployment({ executionGeneration: 0 });

    await expect(adoptLegacyApprovedDeploymentExecutionGeneration({ db, deployment: legacy })).resolves.toEqual({
      ...legacy,
      executionGeneration: 1,
    });

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('execution_generation = 0'));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('build_artifact_key IS NULL'));
    expect(updateBind).toHaveBeenCalledWith(
      'deployment-1',
      'user-1',
      'connection-1',
      1,
      100,
      digest,
      digest,
      'snapshot-1',
    );
  });

  it('reconciles a lost D1 acknowledgement only from the exact adopted approval', async () => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    const committed = row({
      execution_generation: 1,
      build_artifact_key: null,
      build_artifact_generation: null,
    });
    const db = database((query) =>
      query.startsWith('UPDATE')
        ? { bind: vi.fn(() => ({ run: vi.fn(async () => Promise.reject(acknowledgementError)) })) }
        : { bind: vi.fn(() => ({ first: vi.fn(async () => committed) })) },
    );

    await expect(
      adoptLegacyApprovedDeploymentExecutionGeneration({ db, deployment: deployment({ executionGeneration: 0 }) }),
    ).resolves.toMatchObject({ executionGeneration: 1, status: 'approved', approvedAt: 100 });
  });

  it.each([
    ['a reapproved generation', { execution_generation: 2, approved_at: 101 }],
    ['a competing state', { execution_generation: 1, status: 'provisioning' }],
    ['a changed approval identity', { execution_generation: 1, snapshot_key: 'snapshot-2' }],
  ])('preserves the original D1 error when reconciliation observes %s', async (_label, latestOverrides) => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    const db = database((query) =>
      query.startsWith('UPDATE')
        ? { bind: vi.fn(() => ({ run: vi.fn(async () => Promise.reject(acknowledgementError)) })) }
        : {
            bind: vi.fn(() => ({
              first: vi.fn(async () =>
                row({
                  build_artifact_key: null,
                  build_artifact_generation: null,
                  ...latestOverrides,
                }),
              ),
            })),
          },
    );

    await expect(
      adoptLegacyApprovedDeploymentExecutionGeneration({ db, deployment: deployment({ executionGeneration: 0 }) }),
    ).rejects.toBe(acknowledgementError);
  });

  it('rejects malformed generation-zero rows before issuing an adoption write', async () => {
    const db = database(() => {
      throw new Error('unexpected D1 query');
    });

    await expect(
      adoptLegacyApprovedDeploymentExecutionGeneration({
        db,
        deployment: deployment({ executionGeneration: 0, approvedDigest: 'b'.repeat(64) }),
      }),
    ).rejects.toBeInstanceOf(DeploymentStateConflictError);
    expect(db.prepare).not.toHaveBeenCalled();
  });
});

describe('deployment retry and concurrency', () => {
  it('durably queues and releases build artifacts while failing expired Workflow leases', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 2 } }));
    const bind = vi.fn(() => ({ run }));
    const db = database(() => ({ bind }));

    await expect(
      reconcileStaleActiveDeployments({
        db,
        userId: 'user-1',
        staleBefore: 1_000,
        now: 2_000,
      }),
    ).resolves.toBe(2);
    expect(bind).toHaveBeenCalledWith(2_000, 'user-1', 1_000);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('updated_at < ?'));
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('provisioning', 'building', 'deploying')"),
    );
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("ELSE 'cloudflare_cleanup_required'"));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO object_gc_candidates'));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('build_artifact_key IS NOT NULL'));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('build_artifact_key = NULL'));
    expect(db.batch).toHaveBeenCalledOnce();
  });

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
        executionGeneration: 1,
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
        executionGeneration: 1,
      }),
    ).rejects.toBeInstanceOf(DeploymentConcurrencyLimitError);
  });

  it('reconciles a lost claim acknowledgement from the exact approved execution checkpoint', async () => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    let deploymentRead = 0;
    const db = database((query) => {
      if (query.startsWith('SELECT id, chat_id')) {
        const value =
          deploymentRead++ === 0
            ? row({ build_artifact_key: null, build_artifact_generation: null })
            : row({
                status: 'provisioning',
                updated_at: 500,
                build_artifact_key: null,
                build_artifact_generation: null,
              });
        return { bind: vi.fn(() => ({ first: vi.fn(async () => value) })) };
      }
      if (query.includes("SET status = 'provisioning'")) {
        return { bind: vi.fn(() => ({ run: vi.fn(async () => Promise.reject(acknowledgementError)) })) };
      }
      return { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) };
    });

    await expect(
      claimApprovedDeployment({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        executionGeneration: 1,
        now: 500,
      }),
    ).resolves.toMatchObject({ status: 'provisioning', executionGeneration: 1, updatedAt: 500 });
    expect(deploymentRead).toBe(2);
  });

  it.each([
    ['a competing generation', { status: 'provisioning', execution_generation: 2, updated_at: 500 }],
    ['a later phase', { status: 'building', updated_at: 500 }],
    ['a changed approval identity', { status: 'provisioning', approved_at: 101, updated_at: 500 }],
    ['a changed checkpoint timestamp', { status: 'provisioning', updated_at: 501 }],
  ])('preserves the claim error when reconciliation observes %s', async (_label, latestOverrides) => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    let deploymentRead = 0;
    const db = database((query) => {
      if (query.startsWith('SELECT id, chat_id')) {
        const value =
          deploymentRead++ === 0
            ? row({ build_artifact_key: null, build_artifact_generation: null })
            : row({
                build_artifact_key: null,
                build_artifact_generation: null,
                ...latestOverrides,
              });
        return { bind: vi.fn(() => ({ first: vi.fn(async () => value) })) };
      }
      if (query.includes("SET status = 'provisioning'")) {
        return { bind: vi.fn(() => ({ run: vi.fn(async () => Promise.reject(acknowledgementError)) })) };
      }
      return { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) };
    });

    await expect(
      claimApprovedDeployment({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        executionGeneration: 1,
        now: 500,
      }),
    ).rejects.toBe(acknowledgementError);
  });

  it('uses execution generation in status transition compare-and-swap', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const db = database(() => ({ bind }));

    await transitionDeployment({
      db,
      deploymentId: 'deployment-1',
      executionGeneration: 7,
      expectedStatus: 'building',
      nextStatus: 'provisioning',
      now: 500,
    });

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('execution_generation = ?'));
    expect(bind).toHaveBeenCalledWith('provisioning', null, null, null, 0, 0, 500, 'deployment-1', 7, 'building');
  });

  it('queues cleanup and clears only the exact generation artifact during a terminal transition', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const db = database(() => ({ bind }));

    await transitionDeployment({
      db,
      deploymentId: 'deployment-1',
      executionGeneration: 7,
      expectedStatus: 'deploying',
      nextStatus: 'succeeded',
      productionUrl: 'https://example.com',
      now: 500,
    });

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO object_gc_candidates'));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('build_artifact_generation = ?'));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('build_artifact_key = CASE WHEN ? THEN NULL'));
    expect(bind).toHaveBeenCalledWith(expect.any(Number), 500, 'deployment-1', 7, 'deploying', 7);
    expect(db.batch).toHaveBeenCalledOnce();
  });

  it.each([
    ['provisioning', 'building', null],
    ['building', 'provisioning', null],
    ['provisioning', 'deploying', null],
    ['deploying', 'succeeded', 'https://example.com'],
  ] as const)(
    'reconciles a lost %s-to-%s acknowledgement from the exact committed generation and result',
    async (expectedStatus, nextStatus, productionUrl) => {
      const committed = row({
        execution_generation: 7,
        status: nextStatus,
        production_url: productionUrl,
        error_code: null,
        error_message: null,
        ...(nextStatus === 'succeeded' ? { build_artifact_key: null, build_artifact_generation: null } : {}),
      });
      const db = database((query) =>
        query.startsWith('UPDATE')
          ? { bind: vi.fn(() => ({ run: vi.fn(async () => Promise.reject(new Error('D1 acknowledgement lost'))) })) }
          : { bind: vi.fn(() => ({ first: vi.fn(async () => committed) })) },
      );

      await expect(
        transitionDeployment({
          db,
          deploymentId: 'deployment-1',
          executionGeneration: 7,
          expectedStatus,
          nextStatus,
          productionUrl,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it.each([
    { execution_generation: 8 },
    { status: 'deploying' },
    { production_url: 'https://other.example.com' },
    { approved_digest: 'b'.repeat(64) },
  ])('rejects a lost transition acknowledgement when committed identity differs: %o', async (override) => {
    const db = database((query) =>
      query.startsWith('UPDATE')
        ? { bind: vi.fn(() => ({ run: vi.fn(async () => Promise.reject(new Error('D1 acknowledgement lost'))) })) }
        : {
            bind: vi.fn(() => ({
              first: vi.fn(async () => row({ execution_generation: 7, status: 'provisioning', ...override })),
            })),
          },
    );

    await expect(
      transitionDeployment({
        db,
        deploymentId: 'deployment-1',
        executionGeneration: 7,
        expectedStatus: 'building',
        nextStatus: 'provisioning',
      }),
    ).rejects.toThrow('D1 acknowledgement lost');
  });

  it('keeps a resolved zero-change transition as a state conflict', async () => {
    const db = database(() => ({
      bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })),
    }));

    await expect(
      transitionDeployment({
        db,
        deploymentId: 'deployment-1',
        executionGeneration: 7,
        expectedStatus: 'building',
        nextStatus: 'provisioning',
      }),
    ).rejects.toBeInstanceOf(DeploymentStateConflictError);
  });

  it('registers an exact-generation live build reference and durable GC lease before R2 storage', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const db = database(() => ({ bind }));

    await retainDeploymentBuildArtifactReference({
      db,
      deploymentId: 'deployment-1',
      executionGeneration: 7,
      objectKey: 'deployment-builds/deployment-1/execution-7/build.tar.gz',
      now: 500,
    });

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO object_gc_candidates'));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('build_artifact_key = ?'));
    expect(bind).toHaveBeenCalledWith(
      'deployment-builds/deployment-1/execution-7/build.tar.gz',
      7,
      500,
      'deployment-1',
      7,
      'deployment-builds/deployment-1/execution-7/build.tar.gz',
      7,
    );
    expect(db.batch).toHaveBeenCalledOnce();
  });

  it('adopts an exact live build reference when the atomic D1 batch acknowledgement is lost', async () => {
    const committed = row({
      execution_generation: 7,
      status: 'building',
      build_artifact_key: 'deployment-builds/deployment-1/execution-7/build.tar.gz',
      build_artifact_generation: 7,
    });
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() =>
          query.startsWith('SELECT')
            ? { first: vi.fn(async () => committed) }
            : { run: vi.fn(async () => ({ meta: { changes: 1 } })) },
        ),
      })),
      batch: vi.fn(async () => Promise.reject(new Error('D1 acknowledgement lost'))),
    } as unknown as D1Database;

    await expect(
      retainDeploymentBuildArtifactReference({
        db,
        deploymentId: 'deployment-1',
        executionGeneration: 7,
        objectKey: 'deployment-builds/deployment-1/execution-7/build.tar.gz',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a competing build reference from another generation after a lost acknowledgement', async () => {
    const committed = row({
      execution_generation: 8,
      status: 'building',
      build_artifact_key: 'deployment-builds/deployment-1/execution-8/build.tar.gz',
      build_artifact_generation: 8,
    });
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() =>
          query.startsWith('SELECT')
            ? { first: vi.fn(async () => committed) }
            : { run: vi.fn(async () => ({ meta: { changes: 1 } })) },
        ),
      })),
      batch: vi.fn(async () => Promise.reject(new Error('D1 acknowledgement lost'))),
    } as unknown as D1Database;

    await expect(
      retainDeploymentBuildArtifactReference({
        db,
        deploymentId: 'deployment-1',
        executionGeneration: 7,
        objectKey: 'deployment-builds/deployment-1/execution-7/build.tar.gz',
      }),
    ).rejects.toThrow('D1 acknowledgement lost');
  });

  it('reopens the same immutable deployment plan for an approved retry', async () => {
    let deploymentRead = 0;
    const db = database((query) => {
      if (query.includes("SET status = 'failed'")) {
        return { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) };
      }
      return query.startsWith('UPDATE')
        ? { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 1 } })) })) }
        : {
            bind: vi.fn(() => ({
              first: vi.fn(async () =>
                deploymentRead++ === 0
                  ? row({ status: 'failed', error_code: 'deployment_build_failed', updated_at: 100 })
                  : row({
                      status: 'awaiting_approval',
                      approved_digest: null,
                      approved_at: null,
                      build_artifact_key: null,
                      build_artifact_generation: null,
                      error_code: null,
                      error_message: null,
                      updated_at: 200,
                    }),
              ),
            })),
          };
    });
    const retry = await prepareDeploymentRetry({
      db,
      deploymentId: 'deployment-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 1,
      executionGeneration: 1,
      now: 200,
    });
    expect(retry.id).toBe('deployment-1');
    expect(retry.status).toBe('awaiting_approval');
  });

  it('reconciles a lost retry acknowledgement from the exact reopened checkpoint', async () => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    let deploymentRead = 0;
    const db = database((query) => {
      if (query.startsWith('SELECT id, chat_id')) {
        const value =
          deploymentRead++ === 0
            ? row({ status: 'failed', error_code: 'deployment_build_failed', updated_at: 100 })
            : row({
                status: 'awaiting_approval',
                approved_digest: null,
                approved_at: null,
                build_artifact_key: null,
                build_artifact_generation: null,
                error_code: null,
                error_message: null,
                updated_at: 200,
              });
        return { bind: vi.fn(() => ({ first: vi.fn(async () => value) })) };
      }
      if (query.includes("SET status = 'failed'")) {
        return { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) };
      }
      if (query.startsWith('UPDATE deployments')) {
        return { bind: vi.fn(() => ({ run: vi.fn(async () => Promise.reject(acknowledgementError)) })) };
      }
      return { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 1 } })) })) };
    });

    await expect(
      prepareDeploymentRetry({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        executionGeneration: 1,
        now: 200,
      }),
    ).resolves.toMatchObject({ status: 'awaiting_approval', executionGeneration: 1, updatedAt: 200 });
    expect(deploymentRead).toBe(2);
  });

  it.each([
    ['a reapproved generation', { status: 'approved', execution_generation: 2 }],
    ['a changed checkpoint timestamp', { updated_at: 201 }],
    ['a changed connection', { connection_generation: 2 }],
    ['a changed plan', { plan_digest: 'b'.repeat(64) }],
    ['a replaced snapshot', { snapshot_key: 'snapshot-2' }],
    ['an uncleared approval', { approved_digest: digest, approved_at: 200 }],
    ['an uncleared artifact', { build_artifact_key: 'other-build', build_artifact_generation: 1 }],
    ['a later error', { error_code: 'later_error' }],
  ])('preserves the retry error when reconciliation observes %s', async (_label, latestOverrides) => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    let deploymentRead = 0;
    const db = database((query) => {
      if (query.startsWith('SELECT id, chat_id')) {
        const value =
          deploymentRead++ === 0
            ? row({ status: 'failed', error_code: 'deployment_build_failed', updated_at: 100 })
            : row({
                status: 'awaiting_approval',
                approved_digest: null,
                approved_at: null,
                build_artifact_key: null,
                build_artifact_generation: null,
                error_code: null,
                error_message: null,
                updated_at: 200,
                ...latestOverrides,
              });
        return { bind: vi.fn(() => ({ first: vi.fn(async () => value) })) };
      }
      if (query.includes("SET status = 'failed'")) {
        return { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) };
      }
      if (query.startsWith('UPDATE deployments')) {
        return { bind: vi.fn(() => ({ run: vi.fn(async () => Promise.reject(acknowledgementError)) })) };
      }
      return { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 1 } })) })) };
    });

    await expect(
      prepareDeploymentRetry({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        executionGeneration: 1,
        now: 200,
      }),
    ).rejects.toBe(acknowledgementError);
  });

  it('reconciles an expired active lease before reopening the same deployment', async () => {
    const reconciliationBind = vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 1 } })) }));
    const retryBind = vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 1 } })) }));
    let deploymentRead = 0;
    const db = database((query) => {
      if (query.includes("SET status = 'failed'")) {
        return { bind: reconciliationBind };
      }
      if (query.startsWith('UPDATE')) {
        return { bind: retryBind };
      }
      return {
        bind: vi.fn(() => ({
          first: vi.fn(async () =>
            deploymentRead++ === 0
              ? row({ status: 'failed', error_code: 'deployment_interrupted', updated_at: 2_200_000 })
              : row({
                  status: 'awaiting_approval',
                  approved_digest: null,
                  approved_at: null,
                  build_artifact_key: null,
                  build_artifact_generation: null,
                  error_code: null,
                  error_message: null,
                  updated_at: 2_200_000,
                }),
          ),
        })),
      };
    });

    await expect(
      prepareDeploymentRetry({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        executionGeneration: 1,
        now: 2_200_000,
      }),
    ).resolves.toMatchObject({ id: 'deployment-1', status: 'awaiting_approval' });

    expect(reconciliationBind).toHaveBeenCalledWith(2_200_000, 'user-1', 100_000);
    expect(retryBind).toHaveBeenCalledWith(
      2_200_000,
      'deployment-1',
      'user-1',
      'connection-1',
      1,
      1,
      'failed',
      2_200_000,
      digest,
      'snapshot-1',
      digest,
      100,
      'build-key',
      1,
      null,
      'deployment_interrupted',
      null,
    );
  });

  it('does not reopen an active deployment whose lease has not expired', async () => {
    const db = database((query) => {
      if (query.startsWith('UPDATE')) {
        return { bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })) };
      }
      return { bind: vi.fn(() => ({ first: vi.fn(async () => row({ status: 'building' })) })) };
    });

    await expect(
      prepareDeploymentRetry({
        db,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        executionGeneration: 1,
      }),
    ).rejects.toBeInstanceOf(DeploymentStateConflictError);
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
        executionGeneration: 1,
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
    execution_generation: 1,
    build_artifact_key: 'build-key',
    build_artifact_generation: 1,
    snapshot_key: 'snapshot-1',
    status: 'approved',
    plan_json: JSON.stringify(testPlan),
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

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 'deployment-1',
    chatId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    executionGeneration: 1,
    buildArtifactKey: null,
    buildArtifactGeneration: null,
    snapshotKey: 'snapshot-1',
    status: 'approved',
    plan: testPlan,
    planDigest: digest,
    approvedDigest: digest,
    approvedAt: 100,
    productionUrl: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 100,
    ...overrides,
  };
}

function database(prepare: (query: string) => unknown): D1Database {
  return {
    prepare: vi.fn(prepare),
    batch: vi.fn(async (statements: D1PreparedStatement[]) =>
      Promise.all(
        statements.map((statement) =>
          typeof statement.run === 'function' ? statement.run() : Promise.resolve({ meta: { changes: 0 } }),
        ),
      ),
    ),
  } as unknown as D1Database;
}
