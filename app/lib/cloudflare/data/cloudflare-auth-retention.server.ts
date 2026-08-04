const CLOUDFLARE_AUTH_RETENTION_SWEEP_LIMIT = 100;
export const UNREFERENCED_CREDENTIAL_RETENTION_MS = 24 * 60 * 60 * 1000;

type CloudflareAuthRetentionResult = {
  oauthStates: number;
  authSessions: number;
  credentials: number;
};

export async function pruneCloudflareAuthData(args: {
  db: D1Database;
  now?: number;
  limit?: number;
}): Promise<CloudflareAuthRetentionResult> {
  const now = args.now ?? Date.now();
  const limit = args.limit ?? CLOUDFLARE_AUTH_RETENTION_SWEEP_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLOUDFLARE_AUTH_RETENTION_SWEEP_LIMIT) {
    throw new Error('Cloudflare auth retention sweep limit is invalid.');
  }
  const credentialCreatedBefore = now - UNREFERENCED_CREDENTIAL_RETENTION_MS;
  const results = await args.db.batch([
    args.db
      .prepare(
        `DELETE FROM cloudflare_oauth_states
         WHERE id IN (
           SELECT id FROM cloudflare_oauth_states
           WHERE status IN ('pending', 'completed', 'expired', 'error')
             AND expires_at <= ?
           ORDER BY expires_at, id
           LIMIT ?
         )`,
      )
      .bind(now, limit),
    args.db
      .prepare(
        `DELETE FROM cloudflare_auth_sessions
         WHERE id IN (
           SELECT id FROM cloudflare_auth_sessions
           WHERE expires_at <= ?
           ORDER BY expires_at, id
           LIMIT ?
         )`,
      )
      .bind(now, limit),
    args.db
      .prepare(
        `DELETE FROM cloudflare_credentials
         WHERE handle IN (
           SELECT credential.handle
           FROM cloudflare_credentials AS credential
           WHERE credential.created_at <= ?
             AND (credential.rotated_at IS NULL OR credential.rotated_at <= ?)
             AND NOT EXISTS (
               SELECT 1 FROM cloudflare_connections AS connection
               WHERE connection.credential_handle = credential.handle
             )
           ORDER BY credential.created_at, credential.handle
           LIMIT ?
         )
           AND NOT EXISTS (
             SELECT 1 FROM cloudflare_connections AS connection
             WHERE connection.credential_handle = cloudflare_credentials.handle
           )`,
      )
      .bind(credentialCreatedBefore, credentialCreatedBefore, limit),
  ]);
  return {
    oauthStates: results[0].meta.changes,
    authSessions: results[1].meta.changes,
    credentials: results[2].meta.changes,
  };
}

export async function pruneCloudflareAuthDataBestEffort(db: D1Database): Promise<void> {
  try {
    await pruneCloudflareAuthData({ db });
  } catch {
    console.error('Unable to prune expired Cloudflare authorization data');
  }
}
