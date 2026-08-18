import { describe, expect, it, vi } from 'vitest';
import {
  APP_RESOURCE_RECONCILE_GRACE_MS,
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
    listWorkerNames: vi.fn(async () => [] as string[]),
    listD1Databases: vi.fn(async () => []),
    listKvNamespaces: vi.fn(async () => []),
    listR2Buckets: vi.fn(async () => []),
    deleteD1DatabaseById: vi.fn(async () => undefined),
    deleteKvNamespaceById: vi.fn(async () => undefined),
    deleteR2Bucket: vi.fn(async () => true),
    ...overrides,
  };
}

describe('orphaned app resource discovery', () => {
  it('fails the sweep when the Worker listing cannot be read', async () => {
    // Liveness is proven by a Worker's presence, so a partial answer would turn live
    // deployments into orphans. This is the one listing that must be complete or fail.
    await expect(
      findOrphanedAppResources(
        api({
          listWorkerNames: vi.fn(async () => {
            throw new Error('Cloudflare returned more pages than one account listing may read.');
          }),
          listD1Databases: vi.fn(async () => [{ id: 'a', name: `ghostbuild-${DEPLOYMENT}`, createdAt: STALE }]),
        }),
        NOW,
      ),
    ).rejects.toThrow();
  });

  it('skips only the resource kind whose listing could not be read', async () => {
    const result = await findOrphanedAppResources(
      api({
        listD1Databases: vi.fn(async () => [{ id: 'a', name: `ghostbuild-${DEPLOYMENT}`, createdAt: STALE }]),
        listR2Buckets: vi.fn(async () => {
          throw new Error('Cloudflare API request failed (200).');
        }),
      }),
      NOW,
    );

    expect(result.orphans.map((resource) => resource.name)).toEqual([`ghostbuild-${DEPLOYMENT}`]);
  });

  it('treats a present Worker as proof of liveness', async () => {
    const result = await findOrphanedAppResources(
      api({
        listWorkerNames: vi.fn(async () => [`ghostbuild-${LIVE_DEPLOYMENT}`]),
        listD1Databases: vi.fn(async () => [{ id: 'a', name: `ghostbuild-${LIVE_DEPLOYMENT}`, createdAt: STALE }]),
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

  it('carries the provider id the listing already reported', async () => {
    const result = await findOrphanedAppResources(
      api({
        listD1Databases: vi.fn(async () => [{ id: 'db-uuid', name: `ghostbuild-${DEPLOYMENT}`, createdAt: STALE }]),
        listKvNamespaces: vi.fn(async () => [{ id: 'kv-id', name: `ghostbuild-${DEPLOYMENT}-cache` }]),
        listR2Buckets: vi.fn(async () => [{ name: `ghostbuild-${DEPLOYMENT}-storage`, createdAt: STALE }]),
      }),
      NOW,
    );

    expect(result.orphans.map((resource) => [resource.kind, resource.id])).toEqual([
      ['d1', 'db-uuid'],
      ['kv', 'kv-id'],
      // R2 buckets have no id of their own.
      ['r2', `ghostbuild-${DEPLOYMENT}-storage`],
    ]);
  });

  it('never collects a live workspace database that shares the prefix', async () => {
    const result = await findOrphanedAppResources(
      api({
        listWorkerNames: vi.fn(async () => []),
        listD1Databases: vi.fn(async () => [{ id: 'a', name: 'ghostbuild-data-18e073433e6fad63', createdAt: STALE }]),
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
        listD1Databases: vi.fn(async () => [{ id: 'a', name: `ghostbuild-${DEPLOYMENT}`, createdAt: NOW - 1_000 }]),
      }),
      NOW,
    );

    expect(result.orphans).toEqual([]);
  });

  it('dates a cache namespace by its deployment siblings', async () => {
    const result = await findOrphanedAppResources(
      api({
        listD1Databases: vi.fn(async () => [{ id: 'a', name: `ghostbuild-${DEPLOYMENT}`, createdAt: STALE }]),
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

  it('deletes nothing unless the caller asks for enforcement', async () => {
    const deleteD1DatabaseById = vi.fn(async () => undefined);
    const report = await reconcileAppResources(
      api({ listD1Databases: vi.fn(async () => [staleDatabase]), deleteD1DatabaseById }),
      { now: NOW },
    );

    expect(deleteD1DatabaseById).not.toHaveBeenCalled();
    expect(report.orphans).toHaveLength(1);
    expect(report.deleted).toEqual([]);
  });

  it('removes orphaned resources by their recorded id once enforcing', async () => {
    const deleteD1DatabaseById = vi.fn(async () => undefined);
    const deleteR2Bucket = vi.fn(async () => true);
    const report = await reconcileAppResources(
      api({
        listD1Databases: vi.fn(async () => [staleDatabase]),
        listR2Buckets: vi.fn(async () => [{ name: `ghostbuild-${DEPLOYMENT}-storage`, createdAt: STALE }]),
        deleteD1DatabaseById,
        deleteR2Bucket,
      }),
      { now: NOW, mode: 'enforce' },
    );

    // The listing already resolved the id, so deletion never re-reads the account to find it.
    expect(deleteD1DatabaseById).toHaveBeenCalledWith('a');
    expect(deleteR2Bucket).toHaveBeenCalledWith(`ghostbuild-${DEPLOYMENT}-storage`);
    expect(report.deleted).toHaveLength(2);
  });

  it('leaves a bucket uncollected while it still holds objects', async () => {
    const report = await reconcileAppResources(
      api({
        listR2Buckets: vi.fn(async () => [{ name: `ghostbuild-${DEPLOYMENT}-storage`, createdAt: STALE }]),
        deleteR2Bucket: vi.fn(async () => false),
      }),
      { now: NOW, mode: 'enforce' },
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
        deleteD1DatabaseById: vi.fn(async (databaseId: string) => {
          if (databaseId === 'a') {
            throw new Error('Cloudflare API request failed (500).');
          }
        }),
      }),
      { now: NOW, mode: 'enforce' },
    );

    expect(report.deleted.map((resource) => resource.name)).toEqual([`ghostbuild-${DEPLOYMENT}-agent-security`]);
  });

  it('bounds how much a single sweep removes', async () => {
    const databases = Array.from({ length: 9 }, (_, index) => ({
      id: `db-${index}`,
      name: `ghostbuild-${index.toString(16).padStart(8, '0')}-57e1-4d83-9589-1b6c6d982417`,
      createdAt: STALE,
    }));
    const deleteD1DatabaseById = vi.fn(async () => undefined);
    const report = await reconcileAppResources(
      api({ listD1Databases: vi.fn(async () => databases), deleteD1DatabaseById }),
      { now: NOW, mode: 'enforce' },
    );

    expect(report.orphans).toHaveLength(9);
    expect(deleteD1DatabaseById).toHaveBeenCalledTimes(5);
    expect(report.deleted).toHaveLength(5);
  });
});
