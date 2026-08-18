import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { findCloudflareConnectionForUser } from './cloudflare-connection-repository';

/**
 * Rows erased from the operator control plane. Everything else Ghostbuild touches
 * lives in the user's own Cloudflare account or in their browser, so this
 * operation deliberately reaches neither.
 */
type ControlPlaneErasure = {
  oauthStates: number;
  runtimeLocators: number;
  authSessions: number;
  connections: number;
  credentials: number;
  accounts: number;
  cloudflareAuthorizationRevoked: boolean;
};

/**
 * Erase every operator-held record for one account and end the OAuth grant that
 * reaches the user's Cloudflare resources. Deployed Workers, D1, R2, Containers,
 * Durable Objects, Agents, and browser replicas are the user's to remove.
 *
 * Safe to repeat: a second call deletes nothing and reports zero counts.
 */
export async function eraseControlPlaneAccount(args: {
  env: Env;
  userId: string;
  vault?: D1CloudflareCredentialVault;
}): Promise<ControlPlaneErasure> {
  const db = args.env.DB;
  const connection = await findCloudflareConnectionForUser(db, args.userId);
  const credentialHandle = connection?.credentialHandle ?? null;
  const vault = credentialHandle ? (args.vault ?? safeCredentialVault(args.env)) : null;
  const cloudflareAuthorizationRevoked =
    vault && credentialHandle
      ? await vault.revokeOAuthCredential(credentialHandle).catch(() => {
          console.warn('Unable to revoke the Cloudflare grant during account erasure');
          return false;
        })
      : false;

  const results = await db.batch([
    db.prepare('DELETE FROM cloudflare_oauth_states WHERE authenticated_user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM user_computer_runtimes WHERE user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM cloudflare_auth_sessions WHERE user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM cloudflare_connections WHERE user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM "user" WHERE id = ?').bind(args.userId),
  ]);

  // The credential row is referenced by the connection rather than the account,
  // so it can only be removed once that reference is gone.
  const credentials =
    vault && credentialHandle && (await vault.deleteIfUnreferenced(credentialHandle).catch(() => false)) ? 1 : 0;

  return {
    oauthStates: results[0].meta.changes,
    runtimeLocators: results[1].meta.changes,
    authSessions: results[2].meta.changes,
    connections: results[3].meta.changes,
    credentials,
    accounts: results[4].meta.changes,
    cloudflareAuthorizationRevoked,
  };
}

function safeCredentialVault(env: Env): D1CloudflareCredentialVault | null {
  try {
    return D1CloudflareCredentialVault.fromEnv(env);
  } catch {
    // Erasure must still remove the ciphertext when credential configuration is
    // unavailable; the grant then has to be revoked from the Cloudflare dashboard.
    return null;
  }
}
