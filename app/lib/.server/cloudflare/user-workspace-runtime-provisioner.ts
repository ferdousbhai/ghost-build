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
import { recordUserWorkspaceRuntimeResources } from './user-workspace-runtime-resources';
import { deriveUserWorkspaceRuntimeSecret } from './user-workspace-runtime-secret';
import { UserCloudflareAccountApi } from './user-account-api';
import { waitForUserWorkspaceRuntimeReadiness } from './user-workspace-runtime-readiness';
import { sha256Hex } from '~/lib/hex-digest';

const USER_WORKSPACE_SANDBOX_IMAGE =
  'docker.io/cloudflare/sandbox:0.13.0-next.724.1@sha256:d5856e09ccb02c2cd00f73946360369d5655faa9b67b156e0d8627bf143619f1';
const PROVISIONING_LEASE_MS = 40 * 60_000;
export const USER_WORKSPACE_REQUIRED_CAPABILITIES = [
  'workers',
  'containers',
  'd1',
  'r2',
  'kv',
  'durable_objects',
  'workers_ai',
] as const;

export class UserWorkspaceRuntimeProvisioningInProgressError extends Error {
  constructor() {
    super('The project workspace is already being prepared.');
    this.name = 'UserWorkspaceRuntimeProvisioningInProgressError';
  }
}

export class UserWorkspaceContainersPlanRequiredError extends Error {
  constructor(
    providerMessage: string,
    readonly upgradeUrl: string | null,
  ) {
    super(`Cloudflare Containers requires the Workers Paid plan: ${providerMessage}`);
    this.name = 'UserWorkspaceContainersPlanRequiredError';
  }
}

export class UserWorkspaceContainersEligibilityUnknownError extends Error {
  constructor(reason: string) {
    super(`Ghostbuild could not confirm Cloudflare Containers access for this account: ${reason}`);
    this.name = 'UserWorkspaceContainersEligibilityUnknownError';
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
  const suffix = (await sha256Hex(`${connection.accountId}:${args.userId}`)).slice(0, 16);
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
    // Containers are the one workspace capability the OAuth grant cannot promise: the scope is
    // granted, the plan is not. Settle it before anything exists, so an ineligible account is told
    // what to upgrade instead of being left holding an orphaned database and Worker.
    const entitlement = await accountApi.readWorkspaceContainersEntitlement();
    if (entitlement.status === 'plan_required') {
      throw new UserWorkspaceContainersPlanRequiredError(entitlement.message, entitlement.upgradeUrl);
    }
    if (entitlement.status === 'undetermined') {
      throw new UserWorkspaceContainersEligibilityUnknownError(entitlement.reason);
    }
    // Everything past this point creates something in the user's own account, and an attempt can
    // stop anywhere. The names are recorded before the calls that use them, so a provisioning
    // nobody ever retries is still reclaimable; the ids follow as they become known. A failure to
    // record fails the attempt rather than proceeding unrecorded - the retry resumes from here.
    await recordUserWorkspaceRuntimeResources({
      db: args.env.DB,
      userId: args.userId,
      accountId: connection.accountId,
      resources: [
        { resourceType: 'd1', resourceName: databaseName },
        { resourceType: 'worker', resourceName: workerName },
        { resourceType: 'container', resourceName: workerName },
      ],
    });
    const database = await accountApi.ensureD1Database(databaseName);
    await recordUserWorkspaceRuntimeResources({
      db: args.env.DB,
      userId: args.userId,
      accountId: connection.accountId,
      resources: [{ resourceType: 'd1', resourceName: databaseName, providerResourceId: database.id }],
    });
    await accountApi.applyD1Migrations(database.id, USER_WORKSPACE_DATA_MIGRATIONS);
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
    }).catch((persistError) => {
      console.warn('Unable to persist workspace runtime provisioning failure', persistError);
    });
    throw error;
  }
}

function requireRuntimeCapabilities(connection: CloudflareConnection): void {
  const missing = missingUserWorkspaceRuntimeCapabilities(connection);
  if (missing.length > 0) {
    throw new Error(`Reconnect Cloudflare with workspace runtime access: ${missing.join(', ')}.`);
  }
}

export function missingUserWorkspaceRuntimeCapabilities(connection: CloudflareConnection): string[] {
  return USER_WORKSPACE_REQUIRED_CAPABILITIES.filter((capability) => !connection.grantedScopes.includes(capability));
}
