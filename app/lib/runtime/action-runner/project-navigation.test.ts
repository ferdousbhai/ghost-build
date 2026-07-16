import { describe, expect, test } from 'vitest';
import type { FileMap } from 'ghostbuild-agent/types';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { runListFiles, runSearchText } from './project-navigation';
import { TOOL_PAGE_RECORDS } from './bounded-pagination';

describe('project navigation tools', () => {
  test('lists stable bounded pages through the same revision-bound tool', async () => {
    const files = Object.fromEntries(
      Array.from({ length: TOOL_PAGE_RECORDS + 2 }, (_, index) => [
        getAbsolutePath(`src/file-${String(index).padStart(2, '0')}.ts`),
        { type: 'file', content: `export const value${index} = ${index};`, isBinary: false },
      ]),
    ) as FileMap;
    const result = await runListFiles({ input: { path: '/home/project/src' }, files });
    expect(result.coverage).toMatchObject({ complete: false, start: 0, end: TOOL_PAGE_RECORDS, total: 42 });
    const remainder = await runListFiles({
      input: { path: '/home/project/src', cursor: result.coverage?.nextCursor },
      files,
    });
    expect(remainder.coverage).toMatchObject({ complete: true, start: TOOL_PAGE_RECORDS, end: 42, total: 42 });
  });

  test('reports exact match locations and never emits a partial long line', async () => {
    const longLine = `${'x'.repeat(600)}needle`;
    const files = {
      [getAbsolutePath('src/app.ts')]: { type: 'file', content: `needle\n${longLine}`, isBinary: false },
    } as FileMap;
    const result = await runSearchText({
      input: { query: 'needle', path: '/home/project/src' },
      files,
    });
    const records = (result.data as { records: Array<Record<string, unknown>> }).records;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ line: 1, column: 1, lineText: 'needle' });
    expect(records[1]).toMatchObject({ line: 2, column: 601, lineCharacters: longLine.length });
    expect(records[1]).not.toHaveProperty('lineText');
  });
});
