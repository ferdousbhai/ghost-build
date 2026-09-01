import {
  APP_AGENT_DECLARATIVE_EXPORT,
  DEPLOYMENT_COMPATIBILITY_DATE,
  DEPLOYMENT_COMPATIBILITY_FLAGS,
  DEPLOYMENT_OBSERVABILITY,
  DEPLOYMENT_PROJECT_ROOT,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
} from './deployment-runtime-policy';

export type DeploymentConfigInput = {
  accountId: string;
  workerName: string;
  projectType: 'web_app' | 'worker';
  workersAi: boolean;
  appAgent: boolean;
  d1DatabaseId?: string;
  d1DatabaseName?: string;
  agentSecurityD1DatabaseId?: string;
  agentSecurityD1DatabaseName?: string;
  r2BucketName?: string;
  kvNamespaceId?: string;
};

type TrustedDeploymentConfig = {
  name: string;
  account_id: string;
  main: string;
  no_bundle: true;
  compatibility_date: string;
  compatibility_flags: readonly string[];
  observability: typeof DEPLOYMENT_OBSERVABILITY;
  upload_source_maps: true;
  workers_dev: true;
  assets?: { directory: string };
  ai?: { binding: 'AI' };
  d1_databases?: Array<{
    binding: 'DB' | 'AGENT_SECURITY_DB';
    database_name: string;
    database_id: string;
    migrations_dir: string;
  }>;
  r2_buckets?: Array<{ binding: 'APP_STORAGE'; bucket_name: string }>;
  kv_namespaces?: Array<{ binding: 'APP_CACHE'; id: string }>;
  durable_objects?: { bindings: Array<{ name: 'AppAgent'; class_name: 'AppAgent' }> };
  exports?: { AppAgent: typeof APP_AGENT_DECLARATIVE_EXPORT };
  triggers?: { crons: Array<typeof DEPLOYMENT_SECURITY_CLEANUP_CRON> };
};

/** Build the complete trusted Wrangler config; generated projects cannot override deployment policy. */
export function createTrustedDeploymentConfig(args: DeploymentConfigInput): TrustedDeploymentConfig {
  const config: TrustedDeploymentConfig = {
    name: args.workerName,
    account_id: args.accountId,
    main:
      args.projectType === 'worker'
        ? `${DEPLOYMENT_PROJECT_ROOT}/dist/worker/server.js`
        : `${DEPLOYMENT_PROJECT_ROOT}/dist/server/index.js`,
    no_bundle: true,
    compatibility_date: DEPLOYMENT_COMPATIBILITY_DATE,
    compatibility_flags: DEPLOYMENT_COMPATIBILITY_FLAGS,
    observability: DEPLOYMENT_OBSERVABILITY,
    upload_source_maps: true,
    workers_dev: true,
  };
  if (args.projectType === 'web_app') {
    config.assets = { directory: `${DEPLOYMENT_PROJECT_ROOT}/dist/client` };
  }
  if (args.workersAi) {
    config.ai = { binding: 'AI' };
  }
  const d1Databases: NonNullable<TrustedDeploymentConfig['d1_databases']> = [];
  if (args.d1DatabaseId !== undefined) {
    d1Databases.push({
      binding: 'DB',
      database_name: requireCloudflareName(args.d1DatabaseName, 'd1DatabaseName'),
      database_id: requireString(args.d1DatabaseId, 'd1DatabaseId', 64),
      migrations_dir: `${DEPLOYMENT_PROJECT_ROOT}/migrations`,
    });
  }
  if (args.agentSecurityD1DatabaseId !== undefined) {
    d1Databases.push({
      binding: 'AGENT_SECURITY_DB',
      database_name: requireCloudflareName(args.agentSecurityD1DatabaseName, 'agentSecurityD1DatabaseName'),
      database_id: requireString(args.agentSecurityD1DatabaseId, 'agentSecurityD1DatabaseId', 64),
      migrations_dir: `${DEPLOYMENT_PROJECT_ROOT}/agent-security-migrations`,
    });
  }
  if (d1Databases.length > 0) {
    config.d1_databases = d1Databases;
  }
  if (args.r2BucketName !== undefined) {
    config.r2_buckets = [
      { binding: 'APP_STORAGE', bucket_name: requireCloudflareName(args.r2BucketName, 'r2BucketName') },
    ];
  }
  if (args.kvNamespaceId !== undefined) {
    config.kv_namespaces = [{ binding: 'APP_CACHE', id: requireHexId(args.kvNamespaceId, 'kvNamespaceId') }];
  }
  if (args.appAgent) {
    config.durable_objects = { bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] };
    config.exports = { AppAgent: APP_AGENT_DECLARATIVE_EXPORT };
    config.triggers = { crons: [DEPLOYMENT_SECURITY_CLEANUP_CRON] };
  }
  return config;
}

function requireHexId(value: unknown, name: string): string {
  const result = requireString(value, name, 64);
  if (!/^[a-f0-9]{32}$/.test(result)) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return result;
}

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return value;
}

function requireCloudflareName(value: unknown, name: string): string {
  const result = requireString(value, name, 64);
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(result)) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return result;
}
