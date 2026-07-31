import { getSandbox } from '@cloudflare/sandbox';
import {
  BUILDER_PREVIEW_GLOBAL_CONCURRENCY,
  BUILDER_PREVIEW_MAX_BUILDS_PER_HOUR,
} from '~/agents/builder-preview-types';
import type { DeploymentSandbox } from './deployment-sandbox';
import { destroySandboxWithRetries } from './sandbox-lifecycle';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ADMISSION_SWEEP_LIMIT = 8;

type PreviewBuildAdmission = {
  admitted: boolean;
  reason?: 'capacity' | 'user-concurrency' | 'hourly-quota';
};

type BuilderPreviewAccess = {
  id: string;
  ownerId: string;
  agentName: string;
  sandboxId: string;
  workspaceRevision: number;
  snapshotRevision: string;
  port: number;
  expiresAt: number;
};

type BuilderPreviewAccessRow = {
  id: string;
  owner_id: string;
  agent_name: string;
  sandbox_id: string;
  workspace_revision: number;
  snapshot_revision: string;
  port: number;
  expires_at: number;
};

type ExpiredPreviewRow = {
  id: string;
  sandbox_id: string;
  snapshot_key: string;
};

export async function acquirePreviewBuildAdmission(
  db: D1Database,
  args: {
    previewId: string;
    ownerId: string;
    agentName: string;
    sandboxId: string;
    now: number;
    expiresAt: number;
  },
): Promise<PreviewBuildAdmission> {
  const existing = await db
    .prepare(
      `SELECT owner_id, agent_name, sandbox_id
       FROM builder_preview_build_admissions
       WHERE preview_id = ? AND status = 'active' AND expires_at > ?
       LIMIT 1`,
    )
    .bind(args.previewId, args.now)
    .first<{ owner_id: string; agent_name: string; sandbox_id: string }>();
  if (
    existing?.owner_id === args.ownerId &&
    existing.agent_name === args.agentName &&
    existing.sandbox_id === args.sandboxId
  ) {
    return { admitted: true };
  }
  const result = await db
    .prepare(
      `INSERT INTO builder_preview_build_admissions
        (preview_id, owner_id, agent_name, sandbox_id, status, created_at, expires_at)
       SELECT ?, ?, ?, ?, 'active', ?, ?
       WHERE (
         SELECT COUNT(*) FROM builder_preview_build_admissions
         WHERE status = 'active' AND expires_at > ?
       ) < ?
       AND (
         SELECT COUNT(*) FROM builder_preview_build_admissions
         WHERE owner_id = ? AND status = 'active' AND expires_at > ?
       ) < 2
       AND (
         SELECT COUNT(*) FROM builder_preview_build_admissions
         WHERE owner_id = ? AND created_at >= ?
       ) < ?`,
    )
    .bind(
      args.previewId,
      args.ownerId,
      args.agentName,
      args.sandboxId,
      args.now,
      args.expiresAt,
      args.now,
      BUILDER_PREVIEW_GLOBAL_CONCURRENCY,
      args.ownerId,
      args.now,
      args.ownerId,
      args.now - ONE_HOUR_MS,
      BUILDER_PREVIEW_MAX_BUILDS_PER_HOUR,
    )
    .run();
  if (result.meta.changes === 1) {
    return { admitted: true };
  }
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM builder_preview_build_admissions
          WHERE status = 'active' AND expires_at > ?) AS global_active,
         (SELECT COUNT(*) FROM builder_preview_build_admissions
          WHERE owner_id = ? AND status = 'active' AND expires_at > ?) AS owner_active,
         (SELECT COUNT(*) FROM builder_preview_build_admissions
          WHERE owner_id = ? AND created_at >= ?) AS owner_hourly`,
    )
    .bind(args.now, args.ownerId, args.now, args.ownerId, args.now - ONE_HOUR_MS)
    .first<{ global_active: number; owner_active: number; owner_hourly: number }>();
  return {
    admitted: false,
    reason:
      (counts?.owner_hourly ?? 0) >= BUILDER_PREVIEW_MAX_BUILDS_PER_HOUR
        ? 'hourly-quota'
        : (counts?.owner_active ?? 0) >= 2
          ? 'user-concurrency'
          : 'capacity',
  };
}

export function releasePreviewBuildAdmission(db: D1Database, previewId: string, now = Date.now()): Promise<D1Result> {
  return db
    .prepare(
      `UPDATE builder_preview_build_admissions
       SET status = 'released', released_at = ?
       WHERE preview_id = ? AND status = 'active'`,
    )
    .bind(now, previewId)
    .run();
}

export async function registerBuildingPreview(
  db: D1Database,
  args: BuilderPreviewAccess & {
    accessTokenHash: string;
    chatId: string;
    snapshotKey: string;
    createdAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO builder_previews
        (id, owner_id, chat_id, agent_name, sandbox_id, access_token_hash, snapshot_key, workspace_revision,
         snapshot_revision, port, status, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'building', ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      args.id,
      args.ownerId,
      args.chatId,
      args.agentName,
      args.sandboxId,
      args.accessTokenHash,
      args.snapshotKey,
      args.workspaceRevision,
      args.snapshotRevision,
      args.port,
      args.createdAt,
      args.expiresAt,
      args.createdAt,
    )
    .run();
}

export function markPreviewReady(
  db: D1Database,
  previewId: string,
  readyAt: number,
  expiresAt: number,
): Promise<D1Result> {
  return db
    .prepare(
      `UPDATE builder_previews
       SET status = 'ready', ready_at = ?, expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'building'`,
    )
    .bind(readyAt, expiresAt, readyAt, previewId)
    .run();
}

function markPreviewTerminal(
  db: D1Database,
  previewId: string,
  status: 'failed' | 'cancelled' | 'expired',
  now = Date.now(),
): Promise<D1Result> {
  return db
    .prepare(
      `UPDATE builder_previews
       SET status = ?, updated_at = ?
       WHERE id = ? AND status IN ('building', 'ready')`,
    )
    .bind(status, now, previewId)
    .run();
}

export async function resolvePreviewAccess(
  db: D1Database,
  previewId: string,
  accessToken: string,
  now = Date.now(),
): Promise<BuilderPreviewAccess | null> {
  const accessTokenHash = await sha256Hex(accessToken);
  const row = await db
    .prepare(
      `SELECT previews.id, previews.owner_id, previews.agent_name, previews.sandbox_id,
              previews.workspace_revision, previews.snapshot_revision, previews.port, previews.expires_at
       FROM builder_previews AS previews
       INNER JOIN chats ON chats.id = previews.chat_id
       WHERE previews.id = ?
         AND previews.access_token_hash = ?
         AND previews.status = 'ready'
         AND previews.expires_at > ?
         AND chats.creator_id = previews.owner_id
         AND chats.is_deleted = 0
       LIMIT 1`,
    )
    .bind(previewId, accessTokenHash, now)
    .first<BuilderPreviewAccessRow>();
  return row
    ? {
        id: row.id,
        ownerId: row.owner_id,
        agentName: row.agent_name,
        sandboxId: row.sandbox_id,
        workspaceRevision: row.workspace_revision,
        snapshotRevision: row.snapshot_revision,
        port: row.port,
        expiresAt: row.expires_at,
      }
    : null;
}

export async function cleanupExpiredBuilderPreviewsBestEffort(
  env: Pick<Env, 'APP_STORAGE' | 'DB' | 'DeploymentSandbox'>,
  now = Date.now(),
): Promise<void> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, sandbox_id, snapshot_key
       FROM builder_previews
       WHERE expires_at <= ? AND status IN ('building', 'ready')
       ORDER BY expires_at
       LIMIT ?`,
    )
      .bind(now, ADMISSION_SWEEP_LIMIT)
      .all<ExpiredPreviewRow>();
    for (const row of rows.results) {
      await destroyPreviewResources(env, row).catch((error) =>
        console.error('Unable to destroy expired preview resources', error),
      );
      await Promise.all([
        markPreviewTerminal(env.DB, row.id, 'expired', now),
        releasePreviewBuildAdmission(env.DB, row.id, now),
      ]);
    }
    const orphaned = await env.DB.prepare(
      `SELECT preview_id AS id, sandbox_id
       FROM builder_preview_build_admissions
       WHERE status = 'active' AND expires_at <= ?
       ORDER BY expires_at
       LIMIT ?`,
    )
      .bind(now, ADMISSION_SWEEP_LIMIT)
      .all<{ id: string; sandbox_id: string }>();
    for (const row of orphaned.results) {
      await destroyPreviewResources(env, {
        sandbox_id: row.sandbox_id,
        snapshot_key: `builder-previews/${row.id}.zip`,
      }).catch((error) => console.error('Unable to destroy abandoned preview resources', error));
      await env.DB.prepare(
        `UPDATE builder_preview_build_admissions
         SET status = 'expired', released_at = ?
         WHERE preview_id = ? AND status = 'active'`,
      )
        .bind(now, row.id)
        .run();
    }
  } catch (error) {
    console.error('Unable to clean up expired builder previews', error);
  }
}

export async function retireBuilderPreview(
  env: Pick<Env, 'APP_STORAGE' | 'DB' | 'DeploymentSandbox'>,
  previewId: string,
  status: 'failed' | 'cancelled' | 'expired',
  now = Date.now(),
  fallback?: { sandbox_id: string; snapshot_key: string },
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT id, sandbox_id, snapshot_key
     FROM builder_previews
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(previewId)
    .first<ExpiredPreviewRow>();
  const resources = row ?? fallback;
  if (resources) {
    await destroyPreviewResources(env, resources);
  }
  await Promise.all([
    markPreviewTerminal(env.DB, previewId, status, now),
    releasePreviewBuildAdmission(env.DB, previewId, now),
  ]);
}

async function destroyPreviewResources(
  env: Pick<Env, 'APP_STORAGE' | 'DeploymentSandbox'>,
  preview: { sandbox_id: string; snapshot_key: string },
): Promise<void> {
  const sandbox = getSandbox(env.DeploymentSandbox as DurableObjectNamespace<DeploymentSandbox>, preview.sandbox_id, {
    transport: 'rpc',
    enableDefaultSession: false,
    normalizeId: true,
  });
  await Promise.allSettled([
    destroySandboxWithRetries(sandbox, 'Builder preview sandbox'),
    env.APP_STORAGE.delete(preview.snapshot_key),
  ]);
}

export function previewPath(previewId: string, accessToken: string): string {
  return `/api/previews/${encodeURIComponent(previewId)}/${encodeURIComponent(accessToken)}/`;
}

export async function previewAccessTokenHash(accessToken: string): Promise<string> {
  return sha256Hex(accessToken);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
