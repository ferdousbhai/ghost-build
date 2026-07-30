import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSandbox = vi.hoisted(() => vi.fn());
vi.mock('@cloudflare/sandbox', () => ({ getSandbox }));

import {
  acquirePreviewBuildAdmission,
  cleanupExpiredBuilderPreviewsBestEffort,
  markPreviewReady,
  previewAccessTokenHash,
  registerBuildingPreview,
  retireBuilderPreview,
  resolvePreviewAccess,
} from './builder-preview-repository';

const now = 1_750_000_000_000;
const previewId = '123e4567-e89b-42d3-a456-426614174000';
const accessToken = 'A'.repeat(43);

describe('builder preview persistence and admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('authorizes every preview asset through an opaque tenant-scoped capability', async () => {
    const database = previewDatabase();
    insertOwnerAndChat(database.sqlite, 'owner-a', 'chat-a');
    await registerBuildingPreview(database.db, {
      id: previewId,
      ownerId: 'owner-a',
      chatId: 'chat-a',
      agentName: 'agent-a',
      sandboxId: 'sandbox-a',
      accessTokenHash: await previewAccessTokenHash(accessToken),
      snapshotKey: 'builder-previews/source.zip',
      workspaceRevision: 9,
      snapshotRevision: 'snapshot-sha',
      port: 4173,
      createdAt: now,
      expiresAt: now + 60_000,
    });
    await markPreviewReady(database.db, previewId, now + 1, now + 60_000);

    await expect(resolvePreviewAccess(database.db, previewId, accessToken, now + 2)).resolves.toMatchObject({
      id: previewId,
      ownerId: 'owner-a',
      sandboxId: 'sandbox-a',
      workspaceRevision: 9,
      snapshotRevision: 'snapshot-sha',
    });
    await expect(resolvePreviewAccess(database.db, previewId, 'B'.repeat(43), now + 2)).resolves.toBeNull();

    database.sqlite.prepare(`UPDATE chats SET is_deleted = 1 WHERE id = ?`).run('chat-a');
    await expect(resolvePreviewAccess(database.db, previewId, accessToken, now + 2)).resolves.toBeNull();
  });

  it('admits no more builds than the two configured Sandbox instances', async () => {
    const database = previewDatabase();
    for (const owner of ['owner-a', 'owner-b', 'owner-c']) {
      database.sqlite.prepare(`INSERT INTO "user" (id) VALUES (?)`).run(owner);
    }

    await expect(admit(database.db, 'preview-a', 'owner-a')).resolves.toEqual({ admitted: true });
    await expect(admit(database.db, 'preview-a', 'owner-a')).resolves.toEqual({ admitted: true });
    await expect(admit(database.db, 'preview-b', 'owner-b')).resolves.toEqual({ admitted: true });
    await expect(admit(database.db, 'preview-c', 'owner-c')).resolves.toEqual({
      admitted: false,
      reason: 'capacity',
    });
  });

  it('applies owner concurrency and hourly denial-of-wallet quotas', async () => {
    const concurrencyDatabase = previewDatabase();
    concurrencyDatabase.sqlite.prepare(`INSERT INTO "user" (id) VALUES (?)`).run('owner-a');
    await admit(concurrencyDatabase.db, 'preview-1', 'owner-a');
    await admit(concurrencyDatabase.db, 'preview-2', 'owner-a');
    await expect(admit(concurrencyDatabase.db, 'preview-3', 'owner-a')).resolves.toEqual({
      admitted: false,
      reason: 'user-concurrency',
    });

    const quotaDatabase = previewDatabase();
    quotaDatabase.sqlite.prepare(`INSERT INTO "user" (id) VALUES (?)`).run('owner-a');
    const insert = quotaDatabase.sqlite.prepare(
      `INSERT INTO builder_preview_build_admissions
        (preview_id, owner_id, agent_name, sandbox_id, status, created_at, expires_at, released_at)
       VALUES (?, 'owner-a', 'agent-a', ?, 'released', ?, ?, ?)`,
    );
    for (let index = 0; index < 8; index += 1) {
      insert.run(`previous-${index}`, `sandbox-${index}`, now - index, now + 60_000, now);
    }
    await expect(admit(quotaDatabase.db, 'preview-9', 'owner-a')).resolves.toEqual({
      admitted: false,
      reason: 'hourly-quota',
    });
  });

  it('destroys expired sandboxes and snapshots and releases their capacity', async () => {
    const database = previewDatabase();
    insertOwnerAndChat(database.sqlite, 'owner-a', 'chat-a');
    await admit(database.db, previewId, 'owner-a');
    await registerBuildingPreview(database.db, {
      id: previewId,
      ownerId: 'owner-a',
      chatId: 'chat-a',
      agentName: 'agent-a',
      sandboxId: `sandbox-${previewId}`,
      accessTokenHash: await previewAccessTokenHash(accessToken),
      snapshotKey: 'builder-previews/source.zip',
      workspaceRevision: 3,
      snapshotRevision: 'snapshot-sha',
      port: 4173,
      createdAt: now - 2_000,
      expiresAt: now - 1,
    });
    await markPreviewReady(database.db, previewId, now - 1_000, now - 1);
    const destroy = vi.fn().mockResolvedValue(undefined);
    getSandbox.mockReturnValue({ destroy });
    const removeSnapshot = vi.fn().mockResolvedValue(undefined);

    await cleanupExpiredBuilderPreviewsBestEffort(
      {
        DB: database.db,
        APP_STORAGE: { delete: removeSnapshot },
        DeploymentSandbox: {},
      } as never,
      now,
    );

    expect(destroy).toHaveBeenCalledOnce();
    expect(removeSnapshot).toHaveBeenCalledWith('builder-previews/source.zip');
    expect(database.sqlite.prepare(`SELECT status FROM builder_previews WHERE id = ?`).get(previewId)).toEqual({
      status: 'expired',
    });
    expect(
      database.sqlite
        .prepare(`SELECT status FROM builder_preview_build_admissions WHERE preview_id = ?`)
        .get(previewId),
    ).toEqual({ status: 'released' });
  });

  it('cleans an abandoned admitted build even when it crashed before preview registration', async () => {
    const database = previewDatabase();
    database.sqlite.prepare(`INSERT INTO "user" (id) VALUES (?)`).run('owner-a');
    await acquirePreviewBuildAdmission(database.db, {
      previewId,
      ownerId: 'owner-a',
      agentName: 'agent-a',
      sandboxId: 'sandbox-abandoned',
      now: now - 60_001,
      expiresAt: now - 1,
    });
    const destroy = vi.fn().mockResolvedValue(undefined);
    getSandbox.mockReturnValue({ destroy });
    const removeSnapshot = vi.fn().mockResolvedValue(undefined);

    await cleanupExpiredBuilderPreviewsBestEffort(
      {
        DB: database.db,
        APP_STORAGE: { delete: removeSnapshot },
        DeploymentSandbox: {},
      } as never,
      now,
    );

    expect(destroy).toHaveBeenCalledOnce();
    expect(removeSnapshot).toHaveBeenCalledWith(`builder-previews/${previewId}.zip`);
    expect(
      database.sqlite
        .prepare(`SELECT status FROM builder_preview_build_admissions WHERE preview_id = ?`)
        .get(previewId),
    ).toEqual({ status: 'expired' });
  });

  it('cleans queued resources during project or account deletion before D1 preview registration', async () => {
    const database = previewDatabase();
    database.sqlite.prepare(`INSERT INTO "user" (id) VALUES (?)`).run('owner-a');
    await admit(database.db, previewId, 'owner-a');
    const destroy = vi.fn().mockResolvedValue(undefined);
    getSandbox.mockReturnValue({ destroy });
    const removeSnapshot = vi.fn().mockResolvedValue(undefined);

    await retireBuilderPreview(
      {
        DB: database.db,
        APP_STORAGE: { delete: removeSnapshot },
        DeploymentSandbox: {},
      } as never,
      previewId,
      'cancelled',
      now,
      { sandbox_id: `sandbox-${previewId}`, snapshot_key: `builder-previews/${previewId}.zip` },
    );

    expect(destroy).toHaveBeenCalledOnce();
    expect(removeSnapshot).toHaveBeenCalledWith(`builder-previews/${previewId}.zip`);
    expect(
      database.sqlite
        .prepare(`SELECT status FROM builder_preview_build_admissions WHERE preview_id = ?`)
        .get(previewId),
    ).toEqual({ status: 'released' });
  });
});

function admit(db: D1Database, id: string, ownerId: string) {
  return acquirePreviewBuildAdmission(db, {
    previewId: id,
    ownerId,
    agentName: `agent-${ownerId}`,
    sandboxId: `sandbox-${id}`,
    now,
    expiresAt: now + 60_000,
  });
}

function insertOwnerAndChat(sqlite: DatabaseSync, ownerId: string, chatId: string): void {
  sqlite.prepare(`INSERT INTO "user" (id) VALUES (?)`).run(ownerId);
  sqlite
    .prepare(`INSERT INTO chats (id, initial_id, creator_id, is_deleted) VALUES (?, ?, ?, 0)`)
    .run(chatId, `initial-${chatId}`, ownerId);
}

function previewDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "user" (id TEXT PRIMARY KEY);
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      initial_id TEXT NOT NULL,
      creator_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
  `);
  sqlite.exec(readFileSync(new URL('../../../../migrations/0024_builder_previews.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let bindings: unknown[] = [];
      const prepared = {
        bind(...values: unknown[]) {
          bindings = values;
          return prepared;
        },
        async run() {
          const result = statement.run(...(bindings as []));
          return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
        },
        async first<T>() {
          return (statement.get(...(bindings as [])) ?? null) as T | null;
        },
        async all<T>() {
          return { results: statement.all(...(bindings as [])) as T[] };
        },
      };
      return prepared;
    },
  } as unknown as D1Database;
  return { sqlite, db };
}
