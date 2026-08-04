import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  approveDeployment,
  claimApprovedDeployment,
  createDeployment,
  DeploymentConcurrencyLimitError,
  prepareDeploymentRetry,
  requireDeploymentForUser,
  transitionDeployment,
} from './deployment-repository';
import type { DeploymentPlan } from './deployment-plan';
import { DEPLOYMENT_SECURITY_BASELINE_VERSION } from './deployment-security-baseline';

const sourceSha256 = 'a'.repeat(64);
const planDigest = 'b'.repeat(64);
const plan: DeploymentPlan = {
  version: 2,
  deploymentId: 'deployment-1',
  sourceSha256,
  templateSourceSha256: 'c'.repeat(64),
  securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
  securityBoundarySha256: 'd'.repeat(64),
  project: { type: 'web_app', bindings: { ai: false, d1: false, r2: false, appAgent: false } },
  billing: {
    infrastructure: 'user_cloudflare_account',
    workersAi: 'user_cloudflare_account',
    workersPaidUpgrade: 'explicit_user_authorization_required',
  },
  resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-deployment-1' }],
};

let sqlite: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync('user-workspace-migrations/0001_user_workspace.sql', 'utf8'));
  sqlite
    .prepare(
      `INSERT INTO chats (id, creator_id, initial_id, timestamp) VALUES ('chat-1', 'user-1', 'initial-1', 'now')`,
    )
    .run();
  db = d1(sqlite);
});

describe('deployment repository', () => {
  it('stores unlimited lightweight workspace references without artifact state', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await create(index);
    }

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM deployments').get()).toEqual({ count: 4 });
    expect(
      sqlite
        .prepare('PRAGMA table_info(deployments)')
        .all()
        .map((column) => column.name),
    ).not.toEqual(expect.arrayContaining(['snapshot_key', 'build_artifact_key', 'build_artifact_generation']));
  });

  it('approves, claims, and completes the exact connection-bound execution', async () => {
    await create(1);
    const approved = await approveDeployment({
      db,
      deploymentId: 'deployment-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 1,
      approvedDigest: planDigest,
      now: 20,
    });
    expect(approved).toMatchObject({ status: 'approved', executionGeneration: 1, approvedAt: 20 });

    const claimed = await claimApprovedDeployment({
      db,
      deploymentId: approved.id,
      userId: approved.userId,
      connectionId: approved.connectionId,
      connectionGeneration: approved.connectionGeneration,
      executionGeneration: approved.executionGeneration,
      now: 30,
    });
    expect(claimed.status).toBe('provisioning');

    await transitionDeployment({
      db,
      deploymentId: claimed.id,
      executionGeneration: claimed.executionGeneration,
      expectedStatus: 'provisioning',
      nextStatus: 'deploying',
      now: 40,
    });
    await transitionDeployment({
      db,
      deploymentId: claimed.id,
      executionGeneration: claimed.executionGeneration,
      expectedStatus: 'deploying',
      nextStatus: 'succeeded',
      productionUrl: 'https://app.example.workers.dev',
      now: 50,
    });

    await expect(requireDeploymentForUser(db, claimed.id, claimed.userId)).resolves.toMatchObject({
      status: 'succeeded',
      productionUrl: 'https://app.example.workers.dev',
    });
  });

  it('allows only one active deployment per user', async () => {
    const first = await approvedDeployment(1);
    const second = await approvedDeployment(2);
    await claimApprovedDeployment({
      db,
      deploymentId: first.id,
      userId: first.userId,
      connectionId: first.connectionId,
      connectionGeneration: first.connectionGeneration,
      executionGeneration: first.executionGeneration,
    });

    await expect(
      claimApprovedDeployment({
        db,
        deploymentId: second.id,
        userId: second.userId,
        connectionId: second.connectionId,
        connectionGeneration: second.connectionGeneration,
        executionGeneration: second.executionGeneration,
      }),
    ).rejects.toBeInstanceOf(DeploymentConcurrencyLimitError);
  });

  it('returns a failed deployment to approval without artifact cleanup', async () => {
    const approved = await approvedDeployment(1);
    await claimApprovedDeployment({
      db,
      deploymentId: approved.id,
      userId: approved.userId,
      connectionId: approved.connectionId,
      connectionGeneration: approved.connectionGeneration,
      executionGeneration: approved.executionGeneration,
      now: 30,
    });
    await transitionDeployment({
      db,
      deploymentId: approved.id,
      executionGeneration: approved.executionGeneration,
      expectedStatus: 'provisioning',
      nextStatus: 'failed',
      errorCode: 'deployment_provisioning_failed',
      errorMessage: 'failed',
      now: 40,
    });

    await expect(
      prepareDeploymentRetry({
        db,
        deploymentId: approved.id,
        userId: approved.userId,
        connectionId: approved.connectionId,
        connectionGeneration: approved.connectionGeneration,
        executionGeneration: approved.executionGeneration,
        now: 50,
      }),
    ).resolves.toMatchObject({
      status: 'awaiting_approval',
      approvedDigest: null,
      approvedAt: null,
      errorCode: null,
      errorMessage: null,
    });
  });
});

async function create(index: number) {
  return createDeployment({
    db,
    id: `deployment-${index}`,
    chatId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    workspaceReference: `workspace-runtime:project:${index}:${sourceSha256}`,
    plan: { ...plan, deploymentId: `deployment-${index}` },
    planDigest,
    now: index,
  });
}

async function approvedDeployment(index: number) {
  const deployment = await create(index);
  return approveDeployment({
    db,
    deploymentId: deployment.id,
    userId: deployment.userId,
    connectionId: deployment.connectionId,
    connectionGeneration: deployment.connectionGeneration,
    approvedDigest: deployment.planDigest,
    now: 10 + index,
  });
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      return prepared(database.prepare(query));
    },
  } as unknown as D1Database;
}

function prepared(statement: StatementSync) {
  let values: SQLInputValue[] = [];
  return {
    bind(...next: SQLInputValue[]) {
      values = next;
      return this;
    },
    async run() {
      const result = statement.run(...values);
      return { meta: { changes: Number(result.changes) } };
    },
    async first<T>() {
      return (statement.get(...values) as T | undefined) ?? null;
    },
  };
}
