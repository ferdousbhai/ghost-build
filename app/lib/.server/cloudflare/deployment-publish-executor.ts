import { getSandbox, type ExecResult } from '@cloudflare/sandbox';
import type { CloudflareConnection } from './cloudflare-connection-repository';
import { createDeploymentProxyToken } from './deployment-proxy-token';
import type { Deployment } from './deployment-repository';
import type { DeploymentSandbox } from './deployment-sandbox';

const PUBLISH_DIR = '/workspace/publish';
const BUILD_ARCHIVE = '/workspace/build.tar.gz';

export async function publishDeploymentBuild(args: {
  env: Env;
  deployment: Deployment;
  connection: CloudflareConnection;
  build: Uint8Array<ArrayBuffer>;
  d1DatabaseId: string;
  r2BucketName: string;
}): Promise<void> {
  if (!args.env.DeploymentSandbox || !args.env.DEPLOYMENT_PROXY_JWT_SECRET) {
    throw new DeploymentPublishError('Deployment publish sandbox is not configured.');
  }
  const workerName = requireResourceName(args.deployment, 'worker', 'app');
  const sandboxId = `publish-${args.deployment.id}`.toLowerCase();
  const proxyToken = await createDeploymentProxyToken({
    secretBase64: args.env.DEPLOYMENT_PROXY_JWT_SECRET,
    deploymentId: args.deployment.id,
    accountId: args.connection.accountId,
    planDigest: args.deployment.planDigest,
    containerId: sandboxId,
  });
  const sandbox = getSandbox(args.env.DeploymentSandbox as DurableObjectNamespace<DeploymentSandbox>, sandboxId, {
    transport: 'rpc',
    enableDefaultSession: false,
    normalizeId: true,
  });
  const commandEnv = {
    CLOUDFLARE_ACCOUNT_ID: args.connection.accountId,
    CLOUDFLARE_API_TOKEN: proxyToken,
  };
  try {
    await sandbox.mkdir(PUBLISH_DIR, { recursive: true });
    await sandbox.writeFile(BUILD_ARCHIVE, new Blob([args.build]).stream());
    await requireSuccess(await sandbox.exec(`tar -xzf ${BUILD_ARCHIVE} -C ${PUBLISH_DIR}`));
    await sandbox.writeFile(
      `${PUBLISH_DIR}/wrangler.json`,
      JSON.stringify(
        trustedPublishConfig({
          workerName,
          accountId: args.connection.accountId,
          d1DatabaseId: args.d1DatabaseId,
          d1DatabaseName: requireResourceName(args.deployment, 'd1', 'DB'),
          r2BucketName: args.r2BucketName,
        }),
      ),
    );
    await requireSuccess(
      await sandbox.exec('wrangler d1 migrations apply DB --remote --config wrangler.json --yes', {
        cwd: PUBLISH_DIR,
        env: commandEnv,
        timeout: 5 * 60 * 1000,
      }),
    );
    await requireSuccess(
      await sandbox.exec('wrangler deploy --config wrangler.json', {
        cwd: PUBLISH_DIR,
        env: commandEnv,
        timeout: 10 * 60 * 1000,
      }),
    );
  } finally {
    await sandbox.destroy().catch((error) => console.error('Unable to destroy deployment publish sandbox', error));
  }
}

class DeploymentPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentPublishError';
  }
}

function trustedPublishConfig(args: {
  workerName: string;
  accountId: string;
  d1DatabaseId: string;
  d1DatabaseName: string;
  r2BucketName: string;
}) {
  return {
    $schema: 'https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/wrangler/config-schema.json',
    name: args.workerName,
    account_id: args.accountId,
    main: 'dist/server/index.js',
    no_bundle: true,
    compatibility_date: '2026-07-08',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    assets: { directory: 'dist/client' },
    ai: { binding: 'AI' },
    d1_databases: [
      {
        binding: 'DB',
        database_name: args.d1DatabaseName,
        database_id: args.d1DatabaseId,
        migrations_dir: 'migrations',
      },
    ],
    r2_buckets: [{ binding: 'APP_STORAGE', bucket_name: args.r2BucketName }],
    durable_objects: { bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['AppAgent'] }],
  };
}

function requireResourceName(deployment: Deployment, type: string, logicalName: string): string {
  const matches = deployment.plan.resources.filter(
    (resource) => resource.type === type && resource.logicalName === logicalName,
  );
  if (matches.length !== 1 || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(matches[0].proposedName)) {
    throw new DeploymentPublishError(`Approved deployment plan has an invalid ${type} resource.`);
  }
  return matches[0].proposedName;
}

async function requireSuccess(result: ExecResult): Promise<void> {
  if (result.success) {
    return;
  }
  const output = `${result.stderr}\n${result.stdout}`.trim().slice(-4_000);
  throw new DeploymentPublishError(
    output ? `Cloudflare publish command failed (${result.exitCode}): ${output}` : 'Cloudflare publish command failed.',
  );
}
