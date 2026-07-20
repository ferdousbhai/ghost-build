/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { exports, env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

type WorkerdTestEnv = {
  APP_STORAGE: R2Bucket;
  BuilderAgent: DurableObjectNamespace;
  CLOUDFLARE_OAUTH_SCOPES: string;
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const rootWorker = exports as unknown as { default: Fetcher };
const testEnv = env as unknown as WorkerdTestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('root Worker in workerd', () => {
  it('dispatches the health route with application security headers', async () => {
    const response = await rootWorker.default.fetch('https://ghostbuild.test/api/health');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('credentialless');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expect(response.json()).resolves.toMatchObject({ status: 'healthy' });
  });

  it('enforces route methods and API cache policy', async () => {
    const response = await rootWorker.default.fetch('https://ghostbuild.test/api/health', { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Method not allowed' });
  });

  it('loads the Wrangler bindings and exercises local D1 and R2 storage', async () => {
    const migration = await testEnv.DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{
      name: string;
    }>();
    expect(migration?.name).toBe(testEnv.TEST_MIGRATIONS.at(-1)?.name);

    const key = 'workerd-tests/binding-check.txt';
    await testEnv.APP_STORAGE.put(key, 'workerd binding ready');
    const object = await testEnv.APP_STORAGE.get(key);
    expect(object).not.toBeNull();
    await expect(object!.text()).resolves.toBe('workerd binding ready');
    await testEnv.APP_STORAGE.delete(key);

    expect(testEnv.CLOUDFLARE_OAUTH_SCOPES).toContain('workers-scripts.write');
    expect(testEnv.BuilderAgent.idFromName('binding-check').toString()).toBeTruthy();
  });

  it('exposes deployment metadata through the Worker entrypoint', async () => {
    const response = await rootWorker.default.fetch('https://ghostbuild.test/api/version');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sha: 'workerd-test-sha',
      oauthConfigured: true,
    });
  });
});
