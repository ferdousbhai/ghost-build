import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

const workloadTables = ['agent_gc_candidates', 'chat_transcripts', 'chats', 'deployment_resources', 'deployments'];

describe('user-owned workspace D1 schema', () => {
  test('contains only chat and deployment workload metadata', () => {
    const db = database();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));

    expect(tables).toEqual(workloadTables);
    expect(tables).not.toEqual(
      expect.arrayContaining([
        'user',
        'cloudflare_connections',
        'deployment_security_inventory',
        'object_gc_candidates',
      ]),
    );
  });

  test('stores a workspace reference without retaining a build artifact or connection copy', () => {
    const db = database();
    db.prepare(
      `INSERT INTO chats (id, creator_id, initial_id, timestamp)
       VALUES ('chat-1', 'user-1', 'initial-1', '2026-08-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO deployments (
         id, chat_id, user_id, connection_id, connection_generation, workspace_reference,
         status, plan_json, plan_digest, created_at, updated_at
       ) VALUES ('deployment-1', 'chat-1', 'user-1', 'connection-1', 1, 'workspace-runtime:project:1:hash',
         'awaiting_approval', '{}', 'digest', 1, 1)`,
    ).run();

    expect(db.prepare('SELECT workspace_reference, status FROM deployments').get()).toEqual({
      workspace_reference: 'workspace-runtime:project:1:hash',
      status: 'awaiting_approval',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync('user-workspace-migrations/0001_user_workspace.sql', 'utf8'));
  return db;
}
