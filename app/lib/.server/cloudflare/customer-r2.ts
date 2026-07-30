import { findCloudflareConnectionForUser, type CloudflareConnection } from './cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { UserCloudflareAccountApi } from './user-account-api';

export const GHOSTBUILD_CUSTOMER_BUCKET = 'ghostbuild-user-data';

export async function customerR2Api(env: Env, userId: string): Promise<UserCloudflareAccountApi> {
  const connection = await requireCustomerStorageConnection(env.DB, userId);
  const credentialHandle = connection.credentialHandle;
  if (!credentialHandle) {
    throw new Error('Cloudflare authorization is unavailable; reconnect Cloudflare.');
  }
  const accessToken = await D1CloudflareCredentialVault.fromEnv(env).resolve(credentialHandle);
  const expected = {
    id: connection.id,
    accountId: connection.accountId,
    credentialHandle,
    generation: connection.generation,
  };
  return new UserCloudflareAccountApi(connection.accountId, accessToken, fetch, async () => {
    const current = await requireCustomerStorageConnection(env.DB, userId);
    if (
      current.id !== expected.id ||
      current.accountId !== expected.accountId ||
      current.credentialHandle !== expected.credentialHandle ||
      current.generation !== expected.generation
    ) {
      throw new Error('The Cloudflare connection changed while customer storage was being accessed.');
    }
  });
}

async function requireCustomerStorageConnection(db: D1Database, userId: string): Promise<CloudflareConnection> {
  const connection = await findCloudflareConnectionForUser(db, userId);
  if (!connection || connection.status !== 'active' || !connection.credentialHandle) {
    throw new Error('An active Cloudflare connection is required for customer-owned storage.');
  }
  if (!connection.grantedScopes.includes('r2')) {
    throw new Error('Cloudflare storage authorization is missing; reconnect Cloudflare.');
  }
  return connection;
}
