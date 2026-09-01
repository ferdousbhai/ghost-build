import { describe, expect, it } from 'vitest';
import {
  d1DatabaseId,
  d1DatabaseName,
  parseJsonOutput,
  requireMatchingD1Database,
  r2BucketExists,
  setD1DatabaseId,
} from './provision-cloudflare-production.mjs';

const placeholderId = '00000000-0000-0000-0000-000000000000';
const databaseId = '11111111-2222-3333-4444-555555555555';

describe('Cloudflare production provisioning helpers', () => {
  it('updates the configured D1 database id while preserving JSONC comments', () => {
    const raw = `{
  // production database
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "ghostbuild",
      "database_id": "${placeholderId}",
      "migrations_dir": "migrations",
    },
  ],
}
`;

    const updated = setD1DatabaseId(raw, 0, databaseId);

    expect(updated).toContain('// production database');
    expect(updated).toContain(`"database_id": "${databaseId}"`);
    expect(updated).not.toContain(placeholderId);
  });

  it('does not mutate JSONC for empty or placeholder D1 ids', () => {
    const raw = `{"d1_databases":[{"binding":"DB","database_id":"${placeholderId}"}]}`;

    expect(setD1DatabaseId(raw, 0, '')).toBe(raw);
    expect(setD1DatabaseId(raw, 0, placeholderId)).toBe(raw);
  });

  it('parses Wrangler JSON output even when Wrangler emits surrounding text', () => {
    const output = `\nListing D1 databases\n[\n  {"name":"ghostbuild","uuid":"${databaseId}"}\n]\n`;

    expect(parseJsonOutput(output, 'wrangler d1 list --json')).toEqual([{ name: 'ghostbuild', uuid: databaseId }]);
  });

  it('recognizes supported D1 list field variants', () => {
    expect(d1DatabaseId({ uuid: databaseId })).toBe(databaseId);
    expect(d1DatabaseId({ database_id: databaseId })).toBe(databaseId);
    expect(d1DatabaseId({ id: databaseId })).toBe(databaseId);
    expect(d1DatabaseName({ name: 'ghostbuild' })).toBe('ghostbuild');
    expect(d1DatabaseName({ database_name: 'ghostbuild' })).toBe('ghostbuild');
  });

  it('rejects a configured D1 id that resolves to a different database name', () => {
    expect(() =>
      requireMatchingD1Database(
        [{ uuid: databaseId, name: 'unrelated-production-database' }],
        databaseId,
        'ghostbuild',
      ),
    ).toThrow(`Configured D1 database_id ${databaseId} resolves to "unrelated-production-database", not "ghostbuild".`);
  });

  it('rejects a configured D1 id that is absent even when the account has no databases', () => {
    expect(() => requireMatchingD1Database([], databaseId, 'ghostbuild')).toThrow(
      `Configured D1 database_id ${databaseId} was not found in the Cloudflare account.`,
    );
  });

  it('accepts only the remote D1 record matching both configured id and name', () => {
    expect(
      requireMatchingD1Database(
        [
          { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'other' },
          { uuid: databaseId, name: 'ghostbuild' },
        ],
        databaseId,
        'ghostbuild',
      ),
    ).toEqual({ uuid: databaseId, name: 'ghostbuild' });
  });

  it('detects R2 buckets from Wrangler list output', () => {
    expect(r2BucketExists('name\nexample\n ghostbuild-app-storage ', 'ghostbuild-app-storage')).toBe(true);
    expect(r2BucketExists('│ ghostbuild-app-storage │ 2026-06-29 │', 'ghostbuild-app-storage')).toBe(true);
    expect(r2BucketExists('ghostbuild-app-storage 2026-06-29', 'ghostbuild-app-storage')).toBe(true);
    expect(r2BucketExists('name\nexample\nother', 'ghostbuild-app-storage')).toBe(false);
    expect(r2BucketExists('name\nexample\nghostbuild-app-storage-old', 'ghostbuild-app-storage')).toBe(false);
  });
});
