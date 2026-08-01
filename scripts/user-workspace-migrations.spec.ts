import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

const workloadTables = [
  'agent_gc_candidates',
  'chat_transcripts',
  'chats',
  'cloudflare_connections',
  'deployment_resources',
  'deployment_security_inventory',
  'deployments',
  'object_gc_candidates',
];

describe('user-owned workspace D1 schema', () => {
  test('contains only user workload tables and no Ghostbuild control-plane data', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(readFileSync('user-workspace-migrations/0001_user_workspace.sql', 'utf8'));

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));

    expect(tables).toEqual(workloadTables);
    expect(tables).not.toEqual(
      expect.arrayContaining([
        'user',
        'cloudflare_auth_sessions',
        'cloudflare_credentials',
        'feedback',
        'shares',
        'social_shares',
        'chat_backup_objects',
        'thumbnail_objects',
        'user_workspace_runtimes',
      ]),
    );
  });

  test('accepts the runtime connection metadata without copying a user profile', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync('user-workspace-migrations/0001_user_workspace.sql', 'utf8'));
    db.prepare(
      `INSERT INTO cloudflare_connections (
         id, user_id, account_id, account_name, status, credential_handle,
         granted_scopes_json, ai_billing_enabled, connected_at, created_at, updated_at, connection_generation
       ) VALUES (?, ?, ?, ?, 'active', NULL, ?, 1, ?, ?, ?, ?)`,
    ).run('connection', 'user-1', 'account-1', 'Personal', '["workers"]', 10, 10, 10, 1);

    expect(db.prepare('SELECT user_id, account_id FROM cloudflare_connections').get()).toEqual({
      user_id: 'user-1',
      account_id: 'account-1',
    });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'").get()).toBeUndefined();
  });
});
