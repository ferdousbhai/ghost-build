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

export class CloudflareConnectionChangedError extends Error {
  constructor() {
    super('The Cloudflare connection changed while authorization was completing.');
    this.name = 'CloudflareConnectionChangedError';
  }
}

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
  expectedGeneration: number | null;
  now?: number;
}): Promise<CloudflareConnection> {
  const now = args.now ?? Date.now();
  const connectionId = crypto.randomUUID();
  const grantedScopesJson = JSON.stringify(args.grantedScopes);
  let row: CloudflareConnectionRow | null;
  try {
    row =
      args.expectedGeneration === null
        ? await args.db
            .prepare(
              `INSERT INTO cloudflare_connections (
        id, user_id, account_id, account_name, status, credential_handle,
        granted_scopes_json, ai_billing_enabled, connected_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO NOTHING
      RETURNING id, user_id, account_id, account_name, status, credential_handle,
                granted_scopes_json, ai_billing_enabled, connected_at, updated_at, connection_generation`,
            )
            .bind(
              connectionId,
              args.userId,
              args.accountId,
              args.accountName,
              args.credentialHandle,
              grantedScopesJson,
              args.aiBillingEnabled ? 1 : 0,
              now,
              now,
              now,
            )
            .first<CloudflareConnectionRow>()
        : await args.db
            .prepare(
              `UPDATE cloudflare_connections
             SET account_id = ?, account_name = ?, status = 'active', credential_handle = ?,
                 granted_scopes_json = ?, ai_billing_enabled = ?, connected_at = ?,
                 connection_generation = connection_generation + 1, updated_at = ?
             WHERE user_id = ? AND connection_generation = ?
             RETURNING id, user_id, account_id, account_name, status, credential_handle,
                       granted_scopes_json, ai_billing_enabled, connected_at, updated_at, connection_generation`,
            )
            .bind(
              args.accountId,
              args.accountName,
              args.credentialHandle,
              grantedScopesJson,
              args.aiBillingEnabled ? 1 : 0,
              now,
              now,
              args.userId,
              args.expectedGeneration,
            )
            .first<CloudflareConnectionRow>();
  } catch (error) {
    const committed = await findExactActivatedCloudflareConnection({
      ...args,
      connectionId,
      grantedScopesJson,
      now,
    }).catch(() => null);
    if (committed) {
      return committed;
    }
    throw error;
  }
  if (!row) {
    const committed = await findExactActivatedCloudflareConnection({
      ...args,
      connectionId,
      grantedScopesJson,
      now,
    }).catch(() => null);
    if (committed) {
      return committed;
    }
    throw new CloudflareConnectionChangedError();
  }
  return connectionFromRow(row);
}

async function findExactActivatedCloudflareConnection(
  args: Parameters<typeof activateCloudflareConnection>[0] & {
    connectionId: string;
    grantedScopesJson: string;
    now: number;
  },
): Promise<CloudflareConnection | null> {
  const row = await args.db
    .prepare(
      `SELECT id, user_id, account_id, account_name, status, credential_handle,
              granted_scopes_json, ai_billing_enabled, connected_at, updated_at, connection_generation
       FROM cloudflare_connections
       WHERE user_id = ?`,
    )
    .bind(args.userId)
    .first<CloudflareConnectionRow>();
  const intendedGeneration = args.expectedGeneration === null ? 1 : args.expectedGeneration + 1;
  if (
    !row ||
    (args.expectedGeneration === null && row.id !== args.connectionId) ||
    row.user_id !== args.userId ||
    row.account_id !== args.accountId ||
    row.account_name !== args.accountName ||
    row.status !== 'active' ||
    row.credential_handle !== args.credentialHandle ||
    row.granted_scopes_json !== args.grantedScopesJson ||
    row.ai_billing_enabled !== (args.aiBillingEnabled ? 1 : 0) ||
    row.connected_at !== args.now ||
    row.updated_at !== args.now ||
    row.connection_generation !== intendedGeneration
  ) {
    return null;
  }
  return connectionFromRow(row);
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
