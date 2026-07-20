import { describe, expect, test } from 'vitest';
import {
  continuationCursor,
  continuationOffset,
  recordPage,
  textPage,
  TOOL_PAGE_SERIALIZED_CHARACTERS,
} from './bounded-pagination';
import { contentRevision, queryFingerprint } from './revision';

describe('bounded pagination', () => {
  test('reconstructs a large text result exactly through revision-bound cursors', async () => {
    const source = `${'line 🙂\n'.repeat(3_000)}complete-tail`;
    const revision = await contentRevision(source);
    const fingerprint = await queryFingerprint({ tool: 'docs', query: 'example' });
    let cursor: string | undefined;
    let reconstructed = '';
    while (true) {
      const page = textPage(source, continuationOffset(cursor, { revision, fingerprint }));
      expect(JSON.stringify(page.content).length).toBeLessThanOrEqual(TOOL_PAGE_SERIALIZED_CHARACTERS);
      reconstructed += page.content;
      if (page.complete) {
        break;
      }
      cursor = continuationCursor(revision, fingerprint, page.end);
    }
    expect(reconstructed).toBe(source);
  });

  test('bounds record pages by serialized size', () => {
    const records = Array.from({ length: 10 }, (_, index) => ({ index, value: String(index).repeat(3_000) }));
    let start = 0;
    const reconstructed: unknown[] = [];
    while (start < records.length) {
      const page = recordPage(records, start);
      expect(JSON.stringify(page.items).length).toBeLessThanOrEqual(TOOL_PAGE_SERIALIZED_CHARACTERS);
      reconstructed.push(...page.items);
      start = page.end;
    }
    expect(reconstructed).toEqual(records);
  });

  test('rejects an individually oversized record instead of returning an oversized page', () => {
    expect(() => recordPage([{ value: 'x'.repeat(TOOL_PAGE_SERIALIZED_CHARACTERS) }], 0)).toThrow(
      'record exceeds the per-page size limit',
    );
  });

  test('includes JSON escaping in the text-page size bound', () => {
    const page = textPage('\\"'.repeat(TOOL_PAGE_SERIALIZED_CHARACTERS), 0);
    expect(JSON.stringify(page.content).length).toBeLessThanOrEqual(TOOL_PAGE_SERIALIZED_CHARACTERS);
    expect(page.complete).toBe(false);
  });

  test('rejects a cursor after its source revision changes', () => {
    const cursor = continuationCursor('a'.repeat(64), 'b'.repeat(16), 12);
    expect(() => continuationOffset(cursor, { revision: 'c'.repeat(64), fingerprint: 'b'.repeat(16) })).toThrow(
      'underlying content changed',
    );
  });
});
