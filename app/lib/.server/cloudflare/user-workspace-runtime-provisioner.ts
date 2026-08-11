import {
  USER_WORKSPACE_DATA_MIGRATIONS,
  USER_WORKSPACE_RUNTIME_SHA256,
  USER_WORKSPACE_RUNTIME_SOURCE,
} from '~/generated/user-workspace-runtime.generated';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { requireActiveCloudflareConnection, type CloudflareConnection } from './cloudflare-connection-repository';
import {
  claimUserWorkspaceRuntimeProvisioning,
  markUserWorkspaceRuntimeError,
  markUserWorkspaceRuntimeReady,
  type UserWorkspaceRuntime,
} from './user-workspace-runtime-repository';
import { deriveUserWorkspaceRuntimeSecret } from './user-workspace-runtime-secret';
import { UserCloudflareAccountApi } from './user-account-api';
import { waitForUserWorkspaceRuntimeReadiness } from './user-workspace-runtime-readiness';

const USER_WORKSPACE_SANDBOX_IMAGE =
  'docker.io/cloudflare/sandbox:0.13.0-next.724.1@sha256:d5856e09ccb02c2cd00f73946360369d5655faa9b67b156e0d8627bf143619f1';
const PROVISIONING_LEASE_MS = 40 * 60_000;

export const LEGACY_USER_WORKSPACE_MIGRATION_ATTESTATIONS = {
  '0001_user_workspace.sql': userWorkspaceSchemaAttestation(),
} as const;

export class UserWorkspaceRuntimeProvisioningInProgressError extends Error {
  constructor() {
    super('The project workspace is already being prepared.');
    this.name = 'UserWorkspaceRuntimeProvisioningInProgressError';
  }
}

export async function provisionUserWorkspaceRuntime(args: {
  env: Env;
  userId: string;
  connectionId: string;
  request?: typeof fetch;
}): Promise<UserWorkspaceRuntime> {
  if (!args.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error('Cloudflare credential encryption is not configured.');
  }
  const connection = await requireActiveCloudflareConnection(args.env.DB, args.connectionId);
  if (connection.userId !== args.userId || !connection.credentialHandle) {
    throw new Error('The active Cloudflare connection does not belong to this user.');
  }
  requireRuntimeCapabilities(connection);
  const accessToken = await D1CloudflareCredentialVault.fromEnv(args.env).resolve(connection.credentialHandle);
  const accountApi = new UserCloudflareAccountApi(connection.accountId, accessToken);
  const suffix = (await sha256(`${connection.accountId}:${args.userId}`)).slice(0, 16);
  const workerName = `ghostbuild-workspace-${suffix}`;
  const databaseName = `ghostbuild-data-${suffix}`;
  const workersSubdomain = await accountApi.getWorkersSubdomain();
  const endpoint = `https://${workerName}.${workersSubdomain}.workers.dev`;
  const controlPlaneSecret = await deriveUserWorkspaceRuntimeSecret({
    encryptionKeyBase64: args.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY,
    userId: args.userId,
    accountId: connection.accountId,
    connectionGeneration: connection.generation,
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimUserWorkspaceRuntimeProvisioning({
    db: args.env.DB,
    userId: args.userId,
    connectionId: connection.id,
    connectionGeneration: connection.generation,
    workerName,
    endpoint,
    runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
    attemptId,
    leaseExpiresAt: Date.now() + PROVISIONING_LEASE_MS,
  });
  if (!claim.claimed) {
    if (claim.runtime.status === 'ready') {
      return claim.runtime;
    }
    throw new UserWorkspaceRuntimeProvisioningInProgressError();
  }
  try {
    const database = await accountApi.ensureD1Database(databaseName);
    await accountApi.applyD1Migrations(database.id, USER_WORKSPACE_DATA_MIGRATIONS, {
      legacyReceiptAttestations: LEGACY_USER_WORKSPACE_MIGRATION_ATTESTATIONS,
    });
    const deployed = await accountApi.deployWorkspaceRuntimeWorker({
      workerName,
      source: USER_WORKSPACE_RUNTIME_SOURCE,
      controlPlaneSecret,
      runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
      databaseId: database.id,
      userId: args.userId,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      endpoint,
    });
    await accountApi.ensureWorkspaceRuntimeContainer({
      applicationName: workerName,
      namespaceId: deployed.namespaceId,
      image: USER_WORKSPACE_SANDBOX_IMAGE,
    });
    await accountApi.configureWorkspaceRuntimeGcSchedule(workerName);
    await accountApi.enableWorkerSubdomain(workerName);
    await waitForUserWorkspaceRuntimeReadiness({
      endpoint,
      controlPlaneSecret,
      runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
      request: args.request ?? fetch,
    });
    return markUserWorkspaceRuntimeReady({
      db: args.env.DB,
      userId: args.userId,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
      attemptId,
    });
  } catch (error) {
    await markUserWorkspaceRuntimeError({
      db: args.env.DB,
      userId: args.userId,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
      attemptId,
      error: error instanceof Error ? error.message : 'Workspace runtime provisioning failed.',
    }).catch(() => undefined);
    throw error;
  }
}

function userWorkspaceSchemaAttestation(): string {
  const initialMigration = USER_WORKSPACE_DATA_MIGRATIONS.find(({ name }) => name === '0001_user_workspace.sql');
  if (!initialMigration) {
    throw new Error('The initial user workspace migration is missing.');
  }
  const objects = initialMigration.sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => {
      const match = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+([a-z_][a-z0-9_]*)\b/i.exec(statement);
      if (!match) {
        throw new Error('The initial user workspace migration contains an unsupported statement.');
      }
      return {
        type: match[1]!.toLowerCase(),
        name: match[2]!,
        sql: statement.toLowerCase().replaceAll(/\s/g, ''),
      };
    });
  const normalizeSql = `lower(replace(replace(replace(replace(sql,char(9),''),char(10),''),char(13),''),' ',''))`;
  const objectChecks = objects.map(
    ({ type, name, sql }) =>
      `EXISTS (SELECT 1 FROM sqlite_schema WHERE type=${sqlLiteral(type)} AND name=${sqlLiteral(name)} AND ${normalizeSql}=${sqlLiteral(sql)})`,
  );
  return `SELECT CASE WHEN ${objectChecks.join('\n    AND ')}
    AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
    THEN 1 ELSE 0 END AS attested`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function requireRuntimeCapabilities(connection: CloudflareConnection): void {
  const required = ['workers', 'containers', 'd1', 'r2', 'durable_objects', 'workers_ai'];
  const missing = required.filter((capability) => !connection.grantedScopes.includes(capability));
  if (missing.length > 0) {
    throw new Error(`Reconnect Cloudflare with workspace runtime access: ${missing.join(', ')}.`);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
