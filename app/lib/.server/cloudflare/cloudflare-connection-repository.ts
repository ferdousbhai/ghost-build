export type CloudflareConnectionStatus = 'linking' | 'active' | 'revoked' | 'error';

export type CloudflareConnection = {
  id: string;
  userId: string;
  accountId: string;
  accountName: string | null;
  status: CloudflareConnectionStatus;
  credentialHandle: string | null;
  grantedScopes: string[];
  aiBillingEnabled: boolean;
  connectedAt: number | null;
  updatedAt: number;
  generation: number;
};

type CloudflareConnectionRow = {
  id: string;
  user_id: string;
  account_id: string;
  account_name: string | null;
  status: CloudflareConnectionStatus;
  credential_handle: string | null;
  granted_scopes_json: string;
  ai_billing_enabled: number;
  connected_at: number | null;
  updated_at: number;
  connection_generation: number;
};

export async function findCloudflareConnectionForUser(
  db: D1Database,
  userId: string,
): Promise<CloudflareConnection | null> {
  const row = await db
    .prepare(
      `SELECT id, user_id, account_id, account_name, status, credential_handle,
              granted_scopes_json, ai_billing_enabled, connected_at, updated_at, connection_generation
       FROM cloudflare_connections
       WHERE user_id = ?`,
    )
    .bind(userId)
    .first<CloudflareConnectionRow>();
  return row ? connectionFromRow(row) : null;
}

export async function requireActiveCloudflareConnection(
  db: D1Database,
  connectionId: string,
): Promise<CloudflareConnection> {
  const row = await db
    .prepare(
      `SELECT id, user_id, account_id, account_name, status, credential_handle,
              granted_scopes_json, ai_billing_enabled, connected_at, updated_at, connection_generation
       FROM cloudflare_connections
       WHERE id = ? AND status = 'active'`,
    )
    .bind(connectionId)
    .first<CloudflareConnectionRow>();
  if (!row) {
    throw new Error('An active Cloudflare connection is required.');
  }
  return connectionFromRow(row);
}

export async function activateCloudflareConnection(args: {
  db: D1Database;
  userId: string;
  accountId: string;
  accountName: string | null;
  credentialHandle: string;
  grantedScopes: string[];
  aiBillingEnabled: boolean;
  now?: number;
}): Promise<CloudflareConnection> {
  const now = args.now ?? Date.now();
  const id = crypto.randomUUID();
  await args.db
    .prepare(
      `INSERT INTO cloudflare_connections (
        id, user_id, account_id, account_name, status, credential_handle,
        granted_scopes_json, ai_billing_enabled, connected_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        account_id = excluded.account_id,
        account_name = excluded.account_name,
        status = 'active',
        credential_handle = excluded.credential_handle,
        granted_scopes_json = excluded.granted_scopes_json,
        ai_billing_enabled = excluded.ai_billing_enabled,
        connected_at = excluded.connected_at,
        connection_generation = cloudflare_connections.connection_generation + 1,
        updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      args.userId,
      args.accountId,
      args.accountName,
      args.credentialHandle,
      JSON.stringify(args.grantedScopes),
      args.aiBillingEnabled ? 1 : 0,
      now,
      now,
      now,
    )
    .run();
  const connection = await findCloudflareConnectionForUser(args.db, args.userId);
  if (!connection || connection.status !== 'active') {
    throw new Error('Unable to activate the Cloudflare connection.');
  }
  return connection;
}

function connectionFromRow(row: CloudflareConnectionRow): CloudflareConnection {
  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    accountName: row.account_name,
    status: row.status,
    credentialHandle: row.credential_handle,
    grantedScopes: parseGrantedScopes(row.granted_scopes_json),
    aiBillingEnabled: row.ai_billing_enabled === 1,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    generation: row.connection_generation,
  };
}

function parseGrantedScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch {
    return [];
  }
}
