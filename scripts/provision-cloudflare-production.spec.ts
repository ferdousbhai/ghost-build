import { describe, expect, it } from 'vitest';
import {
  d1DatabaseId,
  d1DatabaseName,
  getBinding,
  parseJsonOutput,
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

  it('ignores pnpm engine warnings before Wrangler JSON output', () => {
    const output = `[WARN] Unsupported engine: wanted: {"node":">=26.0.0"} (current: {"node":"v24.14.0"})\n[\n  {"name":"ghostbuild","uuid":"${databaseId}"}\n]\n`;

    expect(parseJsonOutput(output, 'wrangler d1 list --json')).toEqual([{ name: 'ghostbuild', uuid: databaseId }]);
  });

  it('recognizes supported D1 list field variants', () => {
    expect(d1DatabaseId({ uuid: databaseId })).toBe(databaseId);
    expect(d1DatabaseId({ database_id: databaseId })).toBe(databaseId);
    expect(d1DatabaseId({ id: databaseId })).toBe(databaseId);
    expect(d1DatabaseName({ name: 'ghostbuild' })).toBe('ghostbuild');
    expect(d1DatabaseName({ database_name: 'ghostbuild' })).toBe('ghostbuild');
  });

  it('finds configured Cloudflare bindings', () => {
    const config = {
      d1_databases: [{ binding: 'OTHER' }, { binding: 'DB', database_name: 'ghostbuild' }],
    };

    expect(getBinding(config, 'd1_databases', 'DB')).toEqual({
      binding: { binding: 'DB', database_name: 'ghostbuild' },
      index: 1,
    });
  });

  it('detects R2 buckets from Wrangler list output', () => {
    expect(r2BucketExists('name\nexample\n ghostbuild-app-storage ', 'ghostbuild-app-storage')).toBe(true);
    expect(r2BucketExists('│ ghostbuild-app-storage │ 2026-06-29 │', 'ghostbuild-app-storage')).toBe(true);
    expect(r2BucketExists('ghostbuild-app-storage 2026-06-29', 'ghostbuild-app-storage')).toBe(true);
    expect(r2BucketExists('name\nexample\nother', 'ghostbuild-app-storage')).toBe(false);
    expect(r2BucketExists('name\nexample\nghostbuild-app-storage-old', 'ghostbuild-app-storage')).toBe(false);
  });
});
