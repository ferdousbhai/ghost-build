import { describe, expect, it, vi } from 'vitest';
import {
  APP_RESOURCE_RECONCILE_GRACE_MS,
  appDeploymentIdFromResourceName,
  findOrphanedAppResources,
  reconcileAppResources,
  type AppResourceReconcileApi,
} from './app-resource-reconcile.server';

const DEPLOYMENT = 'd6738251-57e1-4d83-9589-1b6c6d982417';
const LIVE_DEPLOYMENT = 'ab11dc5e-5f56-50f3-a54b-02266799dd08';
const NOW = 1_800_000_000_000;
const STALE = NOW - APP_RESOURCE_RECONCILE_GRACE_MS - 1;

function api(overrides: Partial<AppResourceReconcileApi> = {}): AppResourceReconcileApi {
  return {
    listWorkerNames: vi.fn(async () => []),
    listD1Databases: vi.fn(async () => []),
    listKvNamespaces: vi.fn(async () => []),
    listR2Buckets: vi.fn(async () => []),
    deleteD1Database: vi.fn(async () => undefined),
    deleteKvNamespace: vi.fn(async () => undefined),
    deleteR2Bucket: vi.fn(async () => true),
    ...overrides,
  };
}

describe('app deployment id recovery', () => {
  it('recovers the deployment id from every app resource suffix', () => {
    expect(appDeploymentIdFromResourceName(`ghostbuild-${DEPLOYMENT}`)).toBe(DEPLOYMENT);
    expect(appDeploymentIdFromResourceName(`ghostbuild-${DEPLOYMENT}-agent-security`)).toBe(DEPLOYMENT);
    expect(appDeploymentIdFromResourceName(`ghostbuild-${DEPLOYMENT}-storage`)).toBe(DEPLOYMENT);
    expect(appDeploymentIdFromResourceName(`ghostbuild-${DEPLOYMENT}-cache`)).toBe(DEPLOYMENT);
  });

  it('refuses every prefixed resource that is not a UUID deployment', () => {
    // Workspace runtimes and their databases are live infrastructure with a separate lifecycle.
    expect(appDeploymentIdFromResourceName('ghostbuild-workspace-18e073433e6fad63')).toBeNull();
    expect(appDeploymentIdFromResourceName('ghostbuild-data-18e073433e6fad63')).toBeNull();
    expect(appDeploymentIdFromResourceName('ghostbuild-builder-skills')).toBeNull();
    expect(appDeploymentIdFromResourceName('ghostbuild-ops')).toBeNull();
    expect(appDeploymentIdFromResourceName('ghostbuild')).toBeNull();
    expect(appDeploymentIdFromResourceName('summonghost-avatars')).toBeNull();
  });
});

describe('orphaned app resource discovery', () => {
  it('treats a present Worker as proof of liveness', async () => {
    const result = await findOrphanedAppResources(
      api({
        listWorkerNames: vi.fn(async () => [`ghostbuild-${LIVE_DEPLOYMENT}`]),
        listD1Databases: vi.fn(async () => [
          { id: 'a', name: `ghostbuild-${LIVE_DEPLOYMENT}`, createdAt: STALE },
        ]),
      }),
      NOW,
    );

    expect(result.orphans).toEqual([]);
    expect(result.scanned).toBe(1);
  });

  it('collects every resource of a deployment whose Worker is gone', async () => {
    const result = await findOrphanedAppResources(
      api({
        listD1Databases: vi.fn(async () => [
          { id: 'a', name: `ghostbuild-${DEPLOYMENT}`, createdAt: STALE },
          { id: 'b', name: `ghostbuild-${DEPLOYMENT}-agent-security`, createdAt: STALE },
        ]),
        listKvNamespaces: vi.fn(async () => [{ id: 'c', name: `ghostbuild-${DEPLOYMENT}-cache` }]),
        listR2Buckets: vi.fn(async () => [{ name: `ghostbuild-${DEPLOYMENT}-storage`, createdAt: STALE }]),
      }),
      NOW,
    );

    expect(result.orphans.map((resource) => resource.name).sort()).toEqual([
      `ghostbuild-${DEPLOYMENT}`,
      `ghostbuild-${DEPLOYMENT}-agent-security`,
      `ghostbuild-${DEPLOYMENT}-cache`,
      `ghostbuild-${DEPLOYMENT}-storage`,
    ]);
  });

  it('never collects a live workspace database that shares the prefix', async () => {
    const result = await findOrphanedAppResources(
      api({
        listWorkerNames: vi.fn(async () => []),
        listD1Databases: vi.fn(async () => [
          { id: 'a', name: 'ghostbuild-data-18e073433e6fad63', createdAt: STALE },
        ]),
        listR2Buckets: vi.fn(async () => [{ name: 'ghostbuild-builder-skills', createdAt: STALE }]),
      }),
      NOW,
    );

    expect(result.orphans).toEqual([]);
    expect(result.scanned).toBe(0);
  });

  it('spares resources still inside the deployment grace period', async () => {
    const result = await findOrphanedAppResources(
      api({
        listD1Databases: vi.fn(async () => [
          { id: 'a', name: `ghostbuild-${DEPLOYMENT}`, createdAt: NOW - 1_000 },
        ]),
      }),
      NOW,
    );

    expect(result.orphans).toEqual([]);
  });

  it('dates a cache namespace by its deployment siblings', async () => {
    const result = await findOrphanedAppResources(
      api({
        listD1Databases: vi.fn(async () => [
          { id: 'a', name: `ghostbuild-${DEPLOYMENT}`, createdAt: STALE },
        ]),
        listKvNamespaces: vi.fn(async () => [{ id: 'c', name: `ghostbuild-${DEPLOYMENT}-cache` }]),
      }),
      NOW,
    );

    expect(result.orphans.map((resource) => resource.kind).sort()).toEqual(['d1', 'kv']);
  });

  it('skips a deployment whose resources carry no creation time at all', async () => {
    const result = await findOrphanedAppResources(
      api({ listKvNamespaces: vi.fn(async () => [{ id: 'c', name: `ghostbuild-${DEPLOYMENT}-cache` }]) }),
      NOW,
    );

    expect(result.orphans).toEqual([]);
    expect(result.undatable).toEqual([DEPLOYMENT]);
  });
});

describe('app resource reconciliation', () => {
  const staleDatabase = { id: 'a', name: `ghostbuild-${DEPLOYMENT}`, createdAt: STALE };

  it('deletes nothing unless the caller opts out of the dry run', async () => {
    const deleteD1Database = vi.fn(async () => undefined);
    const report = await reconcileAppResources(
      api({ listD1Databases: vi.fn(async () => [staleDatabase]), deleteD1Database }),
      { now: NOW },
    );

    expect(deleteD1Database).not.toHaveBeenCalled();
    expect(report.orphans).toHaveLength(1);
    expect(report.deleted).toEqual([]);
  });

  it('removes orphaned resources once the dry run is disabled', async () => {
    const deleteD1Database = vi.fn(async () => undefined);
    const deleteR2Bucket = vi.fn(async () => true);
    const report = await reconcileAppResources(
      api({
        listD1Databases: vi.fn(async () => [staleDatabase]),
        listR2Buckets: vi.fn(async () => [{ name: `ghostbuild-${DEPLOYMENT}-storage`, createdAt: STALE }]),
        deleteD1Database,
        deleteR2Bucket,
      }),
      { now: NOW, dryRun: false },
    );

    expect(deleteD1Database).toHaveBeenCalledWith(`ghostbuild-${DEPLOYMENT}`);
    expect(deleteR2Bucket).toHaveBeenCalledWith(`ghostbuild-${DEPLOYMENT}-storage`);
    expect(report.deleted).toHaveLength(2);
  });

  it('leaves a bucket uncollected while it still holds objects', async () => {
    const report = await reconcileAppResources(
      api({
        listR2Buckets: vi.fn(async () => [{ name: `ghostbuild-${DEPLOYMENT}-storage`, createdAt: STALE }]),
        deleteR2Bucket: vi.fn(async () => false),
      }),
      { now: NOW, dryRun: false },
    );

    expect(report.deleted).toEqual([]);
    expect(report.orphans).toHaveLength(1);
  });

  it('keeps sweeping after one resource fails to delete', async () => {
    const report = await reconcileAppResources(
      api({
        listD1Databases: vi.fn(async () => [
          staleDatabase,
          { id: 'b', name: `ghostbuild-${DEPLOYMENT}-agent-security`, createdAt: STALE },
        ]),
        deleteD1Database: vi.fn(async (name: string) => {
          if (name === `ghostbuild-${DEPLOYMENT}`) {
            throw new Error('Cloudflare API request failed (500).');
          }
        }),
      }),
      { now: NOW, dryRun: false },
    );

    expect(report.deleted.map((resource) => resource.name)).toEqual([`ghostbuild-${DEPLOYMENT}-agent-security`]);
  });

  it('bounds how much a single sweep removes', async () => {
    const databases = Array.from({ length: 9 }, (_, index) => ({
      id: `db-${index}`,
      name: `ghostbuild-${index.toString(16).padStart(8, '0')}-57e1-4d83-9589-1b6c6d982417`,
      createdAt: STALE,
    }));
    const deleteD1Database = vi.fn(async () => undefined);
    const report = await reconcileAppResources(
      api({ listD1Databases: vi.fn(async () => databases), deleteD1Database }),
      { now: NOW, dryRun: false },
    );

    expect(report.orphans).toHaveLength(9);
    expect(deleteD1Database).toHaveBeenCalledTimes(5);
    expect(report.deleted).toHaveLength(5);
  });
});
