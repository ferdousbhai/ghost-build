import { getSandbox, type ExecResult } from '@cloudflare/sandbox';
import type { CloudflareConnection } from './cloudflare-connection-repository';
import { createDeploymentProxyToken } from './deployment-proxy-token';
import {
  deploymentPlanResourceName,
  deploymentProjectProfile,
  isCurrentDeploymentPlan,
  type DeploymentResourceType,
} from './deployment-plan';
import type { Deployment } from './deployment-repository';
import type { DeploymentSandbox } from './deployment-sandbox';
import {
  APP_AGENT_DECLARATIVE_EXPORT,
  DEPLOYMENT_COMPATIBILITY_DATE,
  DEPLOYMENT_COMPATIBILITY_FLAGS,
  DEPLOYMENT_OBSERVABILITY,
} from './deployment-runtime-policy';
import {
  DEPLOYMENT_SECURITY_BASELINE_BINDING,
  DEPLOYMENT_SECURITY_BOUNDARY_BINDING,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
  DEPLOYMENT_TEMPLATE_SOURCE_BINDING,
  DEPLOYMENT_VERSION_METADATA_BINDING,
} from './deployment-security-baseline';

const PUBLISH_DIR = '/workspace/publish';
const BUILD_ARCHIVE = '/workspace/build.tar.gz';
const WRANGLER_OUTPUT = '/workspace/wrangler-output.ndjson';
const MAX_WRANGLER_OUTPUT_BYTES = 32 * 1024;
const MAX_PUBLISH_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_PUBLISH_EXPANDED_BYTES = 320 * 1024 * 1024;
const MAX_PUBLISH_EXPANDED_KIB = 300 * 1024;

export async function publishDeploymentBuild(args: {
  env: Env;
  deployment: Deployment;
  connection: CloudflareConnection;
  build: Uint8Array<ArrayBuffer>;
  d1DatabaseId?: string;
  agentSecurityD1DatabaseId?: string;
  r2BucketName?: string;
}): Promise<{ workerVersionId: string }> {
  if (!args.env.DeploymentSandbox || !args.env.DEPLOYMENT_PROXY_JWT_SECRET) {
    throw new DeploymentPublishError('Deployment publish sandbox is not configured.');
  }
  if (!isCurrentDeploymentPlan(args.deployment.plan)) {
    throw new DeploymentPublishError('Deployment plan security baseline is stale; prepare and approve a new plan.');
  }
  if (args.build.byteLength > MAX_PUBLISH_ARCHIVE_BYTES) {
    throw new DeploymentPublishError('Deployment build archive exceeds the publish size limit.');
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
    WRANGLER_OUTPUT_FILE_PATH: WRANGLER_OUTPUT,
  };
  let publishedWorkerVersionId: string | null = null;
  try {
    await requireSuccess(
      await sandbox.exec(`rm -rf ${PUBLISH_DIR} ${BUILD_ARCHIVE} ${WRANGLER_OUTPUT}`, {
        timeout: 30 * 1000,
      }),
    );
    await sandbox.mkdir(PUBLISH_DIR, { recursive: true });
    await sandbox.writeFile(BUILD_ARCHIVE, new Blob([args.build]).stream());
    await requireSuccess(
      await sandbox.exec(
        `test "$(gzip -dc ${BUILD_ARCHIVE} | head -c ${MAX_PUBLISH_EXPANDED_BYTES + 1} | wc -c | tr -d ' ')" ` +
          `-le ${MAX_PUBLISH_EXPANDED_BYTES}`,
        { timeout: 2 * 60 * 1000 },
      ),
    );
    await requireSuccess(
      await sandbox.exec(
        `tar -tzf ${BUILD_ARCHIVE} | ` +
          `awk 'BEGIN { bad = 0 } ` +
          `{ name = $0; while (substr(name, 1, 2) == "./") name = substr(name, 3); ` +
          `sub(/\\/$/, "", name); if (name == "") next; ` +
          `if (name ~ /^\\// || name ~ /(^|\\/)\\.\\.?(\\/|$)/ || name ~ /\\\\/) bad = 1; ` +
          `if (seen[name]++) bad = 1 } ` +
          `END { exit bad }' && ` +
          `test -z "$(tar -tvzf ${BUILD_ARCHIVE} | cut -c1 | grep -Ev '^[-d]$' | head -n 1)"`,
        { timeout: 2 * 60 * 1000 },
      ),
    );
    await requireSuccess(
      await sandbox.exec(
        `tar -xzf ${BUILD_ARCHIVE} -C ${PUBLISH_DIR} ` + '--no-same-owner --no-same-permissions --keep-old-files',
        { timeout: 2 * 60 * 1000 },
      ),
    );
    await requireSuccess(
      await sandbox.exec(
        `test "$(du -sk --apparent-size ${PUBLISH_DIR} | cut -f1)" -le ${MAX_PUBLISH_EXPANDED_KIB} && ` +
          `test -z "$(find ${PUBLISH_DIR} -type l -print -quit)"`,
        { timeout: 30 * 1000 },
      ),
    );
    await sandbox.writeFile(
      `${PUBLISH_DIR}/wrangler.json`,
      JSON.stringify(
        trustedPublishConfig({
          deployment: args.deployment,
          workerName,
          accountId: args.connection.accountId,
          d1DatabaseId: args.d1DatabaseId,
          agentSecurityD1DatabaseId: args.agentSecurityD1DatabaseId,
          r2BucketName: args.r2BucketName,
        }),
      ),
    );
    if (args.d1DatabaseId) {
      await requireSuccess(
        await sandbox.exec('wrangler d1 migrations apply DB --remote --config wrangler.json --yes', {
          cwd: PUBLISH_DIR,
          env: commandEnv,
          timeout: 5 * 60 * 1000,
        }),
      );
    }
    if (args.agentSecurityD1DatabaseId) {
      await requireSuccess(
        await sandbox.exec('wrangler d1 migrations apply AGENT_SECURITY_DB --remote --config wrangler.json --yes', {
          cwd: PUBLISH_DIR,
          env: commandEnv,
          timeout: 5 * 60 * 1000,
        }),
      );
    }
    await requireSuccess(
      await sandbox.exec('wrangler deploy --config wrangler.json', {
        cwd: PUBLISH_DIR,
        env: commandEnv,
        timeout: 10 * 60 * 1000,
      }),
    );
    const output = await sandbox.readFile(WRANGLER_OUTPUT, { encoding: 'utf8' });
    publishedWorkerVersionId = parseWranglerDeployVersion(output.content, workerName);
  } finally {
    await sandbox.destroy().catch((error) => console.error('Unable to destroy deployment publish sandbox', error));
  }
  if (!publishedWorkerVersionId) {
    throw new DeploymentPublishError('Published Worker version identity is unavailable.');
  }
  return { workerVersionId: publishedWorkerVersionId };
}

class DeploymentPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentPublishError';
  }
}

function trustedPublishConfig(args: {
  deployment: Deployment;
  workerName: string;
  accountId: string;
  d1DatabaseId?: string;
  agentSecurityD1DatabaseId?: string;
  r2BucketName?: string;
}) {
  const profile = deploymentProjectProfile(args.deployment.plan);
  const config: Record<string, unknown> = {
    $schema: 'https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/wrangler/config-schema.json',
    name: args.workerName,
    account_id: args.accountId,
    main: profile.type === 'worker' ? 'dist/worker/server.js' : 'dist/server/index.js',
    no_bundle: true,
    compatibility_date: DEPLOYMENT_COMPATIBILITY_DATE,
    compatibility_flags: DEPLOYMENT_COMPATIBILITY_FLAGS,
    observability: DEPLOYMENT_OBSERVABILITY,
    upload_source_maps: true,
    workers_dev: true,
    version_metadata: { binding: DEPLOYMENT_VERSION_METADATA_BINDING },
    vars: {
      [DEPLOYMENT_SECURITY_BASELINE_BINDING]: String(args.deployment.plan.securityBaselineVersion),
      [DEPLOYMENT_SECURITY_BOUNDARY_BINDING]: args.deployment.plan.securityBoundarySha256,
      [DEPLOYMENT_TEMPLATE_SOURCE_BINDING]: args.deployment.plan.templateSourceSha256,
    },
  };
  if (profile.type === 'web_app') {
    config.assets = { directory: 'dist/client' };
  }
  if (deploymentPlanResourceName(args.deployment.plan, 'workers_ai', 'AI')) {
    config.ai = { binding: 'AI' };
  }
  const d1Bindings: Array<Record<string, string>> = [];
  const d1Name = deploymentPlanResourceName(args.deployment.plan, 'd1', 'DB');
  if (d1Name || args.d1DatabaseId) {
    if (!d1Name || !args.d1DatabaseId) {
      throw new DeploymentPublishError('Approved deployment plan is missing its D1 resource result.');
    }
    d1Bindings.push({
      binding: 'DB',
      database_name: d1Name,
      database_id: args.d1DatabaseId,
      migrations_dir: 'migrations',
    });
  }
  const agentSecurityD1Name = deploymentPlanResourceName(args.deployment.plan, 'd1', 'AGENT_SECURITY_DB');
  if (agentSecurityD1Name || args.agentSecurityD1DatabaseId) {
    if (!agentSecurityD1Name || !args.agentSecurityD1DatabaseId) {
      throw new DeploymentPublishError('Approved deployment plan is missing its agent security D1 resource result.');
    }
    if (args.agentSecurityD1DatabaseId === args.d1DatabaseId) {
      throw new DeploymentPublishError('Application and agent security D1 resources must be separate.');
    }
    d1Bindings.push({
      binding: 'AGENT_SECURITY_DB',
      database_name: agentSecurityD1Name,
      database_id: args.agentSecurityD1DatabaseId,
      migrations_dir: 'agent-security-migrations',
    });
  }
  if (d1Bindings.length > 0) {
    config.d1_databases = d1Bindings;
  }
  const r2Name = deploymentPlanResourceName(args.deployment.plan, 'r2', 'APP_STORAGE');
  if (r2Name || args.r2BucketName) {
    if (!r2Name || args.r2BucketName !== r2Name) {
      throw new DeploymentPublishError('Approved deployment plan is missing its R2 resource result.');
    }
    config.r2_buckets = [{ binding: 'APP_STORAGE', bucket_name: args.r2BucketName }];
  }
  if (deploymentPlanResourceName(args.deployment.plan, 'durable_object', 'AppAgent')) {
    config.durable_objects = { bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] };
    config.exports = { AppAgent: APP_AGENT_DECLARATIVE_EXPORT };
    config.triggers = { crons: [DEPLOYMENT_SECURITY_CLEANUP_CRON] };
  }
  return config;
}

function requireResourceName(deployment: Deployment, type: DeploymentResourceType, logicalName: string): string {
  const name = deploymentPlanResourceName(deployment.plan, type, logicalName);
  if (!name) {
    throw new DeploymentPublishError(`Approved deployment plan has an invalid ${type} resource.`);
  }
  return name;
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

function parseWranglerDeployVersion(content: string, expectedWorkerName: string): string {
  if (new TextEncoder().encode(content).byteLength > MAX_WRANGLER_OUTPUT_BYTES) {
    throw new DeploymentPublishError('Wrangler structured output exceeds the size limit.');
  }
  const matches: string[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let entry: { type?: unknown; version?: unknown; worker_name?: unknown; version_id?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      throw new DeploymentPublishError('Wrangler returned invalid structured output.');
    }
    if (
      entry.type === 'deploy' &&
      entry.version === 1 &&
      entry.worker_name === expectedWorkerName &&
      typeof entry.version_id === 'string'
    ) {
      matches.push(entry.version_id);
    }
  }
  if (matches.length !== 1 || !/^[0-9a-f-]{32,64}$/i.test(matches[0])) {
    throw new DeploymentPublishError('Wrangler did not identify exactly one published Worker version.');
  }
  return matches[0];
}
