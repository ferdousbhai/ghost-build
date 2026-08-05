import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { LEGACY_USER_WORKSPACE_MIGRATION_ATTESTATIONS } from './user-workspace-runtime-provisioner';

describe('legacy user workspace migration attestation', () => {
  it('attests every exact schema object created by the immutable initial migration', () => {
    const attestation = LEGACY_USER_WORKSPACE_MIGRATION_ATTESTATIONS['0001_user_workspace.sql'];
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync('user-workspace-migrations/0001_user_workspace.sql', 'utf8'));

    expect(db.prepare(attestation).get()).toEqual({ attested: 1 });
    for (const row of db
      .prepare("SELECT name FROM sqlite_schema WHERE sql IS NOT NULL AND type IN ('table','index')")
      .all()) {
      expect(attestation).toContain(`name='${String(row.name)}'`);
    }
    expect(attestation).toContain('pragma_foreign_key_check');
  });

  it.each([
    ['column type and nullability', '  initial_id TEXT NOT NULL,', '  initial_id BLOB,'],
    ['table check constraint', ' DEFAULT 0 CHECK (is_deleted IN (0, 1))', ' DEFAULT 0'],
    ['partial unique index definition', 'ON chats(creator_id, initial_id)', 'ON chats(creator_id, description)'],
  ])('rejects a workspace with a changed %s', (_label, current, changed) => {
    const db = new DatabaseSync(':memory:');
    const migration = readFileSync('user-workspace-migrations/0001_user_workspace.sql', 'utf8').replace(
      current,
      changed,
    );
    expect(migration).not.toBe(readFileSync('user-workspace-migrations/0001_user_workspace.sql', 'utf8'));
    db.exec(migration);

    expect(db.prepare(LEGACY_USER_WORKSPACE_MIGRATION_ATTESTATIONS['0001_user_workspace.sql']).get()).toEqual({
      attested: 0,
    });
  });

  it('rejects a pre-launch-shaped schema missing the current workspace contract', () => {
    const db = new DatabaseSync(':memory:');
    const historical = readFileSync('user-workspace-migrations/0001_user_workspace.sql', 'utf8')
      .replace('  workspace_reference TEXT NOT NULL,\n', '')
      .replace(
        "    status IN ('awaiting_approval', 'approved', 'provisioning', 'deploying', 'succeeded', 'failed')",
        "    status IN ('planned', 'awaiting_approval', 'approved', 'provisioning', 'building', 'deploying', 'succeeded', 'failed', 'canceled')",
      );
    db.exec(historical);

    expect(db.prepare(LEGACY_USER_WORKSPACE_MIGRATION_ATTESTATIONS['0001_user_workspace.sql']).get()).toEqual({
      attested: 0,
    });
  });
});
