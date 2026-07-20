import { describe, expect, test } from 'vitest';
import type { Deployment } from './deployment-repository';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from './deployment-security-baseline';
import {
  deploymentBuildArtifactKey,
  loadDeploymentBuildArtifact,
  readStoredDeploymentBuildReceipt,
  storeDeploymentBuildArtifact,
} from './deployment-build-artifact';

describe('durable deployment build artifacts', () => {
  test('stores a deterministic, content-addressed receipt and verifies it across the Workflow boundary', async () => {
    const storage = new BuildArtifactBucket();
    const current = deployment();
    const build = new Uint8Array([1, 2, 3, 4]);

    const receipt = await storeDeploymentBuildArtifact({ env: storage.env, deployment: current, build });

    expect(receipt.objectKey).toBe(deploymentBuildArtifactKey(current));
    expect(receipt.deploymentId).toBe(current.id);
    expect(receipt.executionGeneration).toBe(current.executionGeneration);
    expect(receipt.planDigest).toBe(current.planDigest);
    expect(receipt.sourceSha256).toBe(current.plan.sourceSha256);
    await expect(readStoredDeploymentBuildReceipt({ env: storage.env, deployment: current })).resolves.toEqual(receipt);
    await expect(loadDeploymentBuildArtifact({ env: storage.env, deployment: current, receipt })).resolves.toEqual(
      build,
    );
  });

  test('rejects a receipt replayed against another approved plan before reading its bytes', async () => {
    const storage = new BuildArtifactBucket();
    const current = deployment();
    const receipt = await storeDeploymentBuildArtifact({
      env: storage.env,
      deployment: current,
      build: new Uint8Array([1]),
    });

    await expect(
      loadDeploymentBuildArtifact({
        env: storage.env,
        deployment: { ...current, planDigest: 'd'.repeat(64), approvedDigest: 'd'.repeat(64) },
        receipt,
      }),
    ).rejects.toThrow('receipt does not match the approved deployment');
  });

  test('rejects R2 bytes changed after the cryptographic receipt was persisted', async () => {
    const storage = new BuildArtifactBucket();
    const current = deployment();
    const receipt = await storeDeploymentBuildArtifact({
      env: storage.env,
      deployment: current,
      build: new Uint8Array([1, 2, 3]),
    });
    storage.replaceBytes(receipt.objectKey, new Uint8Array([3, 2, 1]));

    await expect(loadDeploymentBuildArtifact({ env: storage.env, deployment: current, receipt })).rejects.toThrow(
      'failed integrity verification',
    );
  });

  test('keeps one immutable artifact when concurrent builders race within the same approval generation', async () => {
    const storage = new BuildArtifactBucket();
    const current = deployment();

    const receipts = await Promise.all([
      storeDeploymentBuildArtifact({ env: storage.env, deployment: current, build: new Uint8Array([1]) }),
      storeDeploymentBuildArtifact({ env: storage.env, deployment: current, build: new Uint8Array([2]) }),
    ]);

    expect(storage.putCommits).toBe(1);
    expect(storage.putConditions).toEqual([{ etagDoesNotMatch: '*' }, { etagDoesNotMatch: '*' }]);
    expect(receipts[0]).toEqual(receipts[1]);
    await expect(
      loadDeploymentBuildArtifact({ env: storage.env, deployment: current, receipt: receipts[0] }),
    ).resolves.toEqual(expect.any(Uint8Array));
  });

  test('recovers the committed receipt when the conditional R2 put acknowledgement is lost', async () => {
    const storage = new BuildArtifactBucket();
    const current = deployment();
    storage.loseNextPutAcknowledgement = true;

    const receipt = await storeDeploymentBuildArtifact({
      env: storage.env,
      deployment: current,
      build: new Uint8Array([1, 2, 3]),
    });

    expect(storage.putCommits).toBe(1);
    await expect(loadDeploymentBuildArtifact({ env: storage.env, deployment: current, receipt })).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  test('stale cleanup from a failed attempt cannot delete the manually reapproved generation', async () => {
    const storage = new BuildArtifactBucket();
    const previous = deployment();
    const previousReceipt = await storeDeploymentBuildArtifact({
      env: storage.env,
      deployment: previous,
      build: new Uint8Array([1]),
    });
    const reapproved = { ...previous, executionGeneration: previous.executionGeneration + 1 };
    const activeReceipt = await storeDeploymentBuildArtifact({
      env: storage.env,
      deployment: reapproved,
      build: new Uint8Array([2]),
    });

    expect(activeReceipt.objectKey).not.toBe(previousReceipt.objectKey);
    storage.delete(previousReceipt.objectKey);
    await expect(
      loadDeploymentBuildArtifact({ env: storage.env, deployment: reapproved, receipt: activeReceipt }),
    ).resolves.toEqual(new Uint8Array([2]));
  });

  test('rejects a receipt replayed into a later approval of the same plan and snapshot', async () => {
    const storage = new BuildArtifactBucket();
    const previous = deployment();
    const receipt = await storeDeploymentBuildArtifact({
      env: storage.env,
      deployment: previous,
      build: new Uint8Array([1]),
    });
    const reapproved = { ...previous, executionGeneration: previous.executionGeneration + 1 };

    await expect(loadDeploymentBuildArtifact({ env: storage.env, deployment: reapproved, receipt })).rejects.toThrow(
      'receipt does not match the approved deployment',
    );
  });
});

type StoredObject = {
  bytes: Uint8Array<ArrayBuffer>;
  customMetadata: Record<string, string>;
  sha256: ArrayBuffer;
};

class BuildArtifactBucket {
  private readonly objects = new Map<string, StoredObject>();
  putCommits = 0;
  loseNextPutAcknowledgement = false;
  readonly putConditions: Array<R2Conditional | Headers | undefined> = [];

  readonly env = {
    APP_STORAGE: {
      put: async (key: string, value: Uint8Array<ArrayBuffer>, options: R2PutOptions) => {
        this.putConditions.push(options.onlyIf);
        if (options.onlyIf && this.objects.has(key)) {
          return null;
        }
        this.objects.set(key, {
          bytes: value.slice(),
          customMetadata: { ...(options.customMetadata ?? {}) },
          sha256: (options.sha256 as Uint8Array<ArrayBuffer>).buffer.slice(0),
        });
        this.putCommits++;
        if (this.loseNextPutAcknowledgement) {
          this.loseNextPutAcknowledgement = false;
          throw new Error('R2 acknowledgement lost');
        }
        return {} as R2Object;
      },
      head: async (key: string) => this.object(key),
      get: async (key: string) => {
        const object = this.object(key);
        if (!object) {
          return null;
        }
        return {
          ...object,
          arrayBuffer: async () => this.objects.get(key)?.bytes.buffer.slice(0) ?? new ArrayBuffer(0),
        } as R2ObjectBody;
      },
    },
  } as unknown as Pick<Env, 'APP_STORAGE'>;

  replaceBytes(key: string, bytes: Uint8Array<ArrayBuffer>): void {
    const object = this.objects.get(key);
    if (object) {
      object.bytes = bytes;
    }
  }

  delete(key: string): void {
    this.objects.delete(key);
  }

  private object(key: string): R2Object | null {
    const stored = this.objects.get(key);
    if (!stored) {
      return null;
    }
    return {
      key,
      size: stored.bytes.byteLength,
      customMetadata: stored.customMetadata,
      checksums: { sha256: stored.sha256 },
    } as R2Object;
  }
}

function deployment(): Deployment {
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
    status: 'provisioning',
    plan: {
      version: 2,
      deploymentId: 'deployment-1',
      sourceSha256: 'a'.repeat(64),
      templateSourceSha256: TEMPLATE_SOURCE_SHA256,
      securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
      securityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
      project: {
        type: 'web_app',
        bindings: { ai: true, d1: true, r2: true, appAgent: true },
      },
      billing: {
        infrastructure: 'user_cloudflare_account',
        workersAi: 'user_cloudflare_account',
        workersPaidUpgrade: 'explicit_user_authorization_required',
      },
      resources: [
        { type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-deployment-1' },
        { type: 'd1', logicalName: 'DB', proposedName: 'ghostbuild-deployment-1' },
        {
          type: 'd1',
          logicalName: 'AGENT_SECURITY_DB',
          proposedName: 'ghostbuild-deployment-1-agent-security',
        },
      ],
    },
    planDigest: 'b'.repeat(64),
    approvedDigest: 'b'.repeat(64),
    approvedAt: 1,
    productionUrl: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
  };
}
