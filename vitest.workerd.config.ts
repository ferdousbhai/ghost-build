import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const rootDirectory = dirname(fileURLToPath(import.meta.url));
const fromRoot = (path: string) => resolve(rootDirectory, path);

const testSecrets = {
  CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-key',
  CLOUDFLARE_OAUTH_CLIENT_SECRET: 'test-oauth-secret',
  DEPLOYMENT_PROXY_JWT_SECRET: 'test-deployment-secret',
};

for (const [name, value] of Object.entries(testSecrets)) {
  process.env[name] = value;
}

const serverDependencyStubs = new Set([
  '@tanstack/react-start/server-entry',
  './agents/builder-agent',
  './lib/.server/agent-request-identity',
  './lib/.server/cloudflare/deployment-sandbox',
  './lib/.server/cloudflare/deployment-workflow',
  './lib/.server/cloudflare/skill-sync-workflow',
  './lib/cloudflare/data.server',
  './lib/cloudflare/data/cloudflare-auth-retention.server',
  './lib/cloudflare/data/deferred-gc.server',
  './server-handlers/auth',
  './server-handlers/client-telemetry',
  './server-handlers/cloudflare-integration',
  './server-handlers/deployments',
  './server-handlers/enhance-prompt',
  './server-handlers/feedback',
  './server-handlers/scripts',
]);

function isolateRootWorkerRoutes(): Plugin {
  const stub = fromRoot('./tests/workerd/server-dependencies.stub.ts');
  return {
    name: 'ghostbuild-workerd-route-boundaries',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer?.endsWith('/app/server.ts') && serverDependencyStubs.has(source)) {
        return stub;
      }
    },
  };
}

export default defineConfig({
  plugins: [
    isolateRootWorkerRoutes(),
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Production secrets are never needed by local integration tests.
          ...testSecrets,
          CLOUDFLARE_OAUTH_CLIENT_ID: 'test-oauth-client',
          TEST_MIGRATIONS: await readD1Migrations(fromRoot('./migrations')),
          COMMIT_SHA: 'workerd-test-sha',
        },
      },
    })),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ['tests/workerd/**/*.integration.ts'],
  },
});
