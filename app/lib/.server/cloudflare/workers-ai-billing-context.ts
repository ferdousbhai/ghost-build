import type { WorkersAiAccountCredentials } from '~/lib/.server/llm/provider';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { findCloudflareConnectionForUser } from './cloudflare-connection-repository';

export async function getUserWorkersAiCredentials(env: Env, userId: string): Promise<WorkersAiAccountCredentials> {
  if (!userId) {
    throw new Error('Cloudflare authentication is required.');
  }
  const connection = await findCloudflareConnectionForUser(env.DB, userId);
  if (!connection || connection.status !== 'active' || !connection.aiBillingEnabled) {
    throw new Error('An active Cloudflare account with Workers AI access is required.');
  }
  if (!connection.credentialHandle) {
    throw new Error('Connected Cloudflare account has no credential handle.');
  }
  const vault = D1CloudflareCredentialVault.fromEnv(env);
  return {
    accountId: connection.accountId,
    apiKey: await vault.resolve(connection.credentialHandle),
  };
}
