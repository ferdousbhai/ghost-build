import { describe, expect, test } from 'vitest';
import type { FileMap } from 'ghostbuild-agent/types';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { runListFiles, runSearchText } from './project-navigation';
import { TOOL_PAGE_RECORDS, TOOL_PAGE_SERIALIZED_CHARACTERS } from './bounded-pagination';

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

  test('filters glob results and excludes binary, generated, dependency, and build-output paths', async () => {
    const files = {
      [getAbsolutePath('src/index.tsx')]: { type: 'file', content: 'export default null;', isBinary: false },
      [getAbsolutePath('src/routes/chat.tsx')]: { type: 'file', content: 'export default null;', isBinary: false },
      [getAbsolutePath('src/routeTree.gen.ts')]: { type: 'file', content: 'generated', isBinary: false },
      [getAbsolutePath('src/logo.png')]: { type: 'file', content: '', isBinary: true },
      [getAbsolutePath('src/.env.tsx')]: { type: 'file', content: 'SECRET=value', isBinary: false },
      [getAbsolutePath('dist/app.tsx')]: { type: 'file', content: 'built', isBinary: false },
      [getAbsolutePath('node_modules/pkg/index.tsx')]: { type: 'file', content: 'vendor', isBinary: false },
    } as FileMap;

    const result = await runListFiles({ input: { glob: 'src/**/*.tsx' }, files });

    expect((result.data as { records: Array<{ path: string }> }).records.map((record) => record.path)).toEqual([
      '/home/project/src/index.tsx',
      '/home/project/src/routes/chat.tsx',
    ]);
  });

  test('ranks definitions, request context, and recent edits and returns file revisions', async () => {
    const definitionPath = getAbsolutePath('src/server/webhook.ts');
    const recentPath = getAbsolutePath('src/routes/index.tsx');
    const files = {
      [recentPath]: { type: 'file', content: 'const result = verifyWebhook(payload);', isBinary: false },
      [definitionPath]: {
        type: 'file',
        content: 'export function verifyWebhook(payload: string) { return payload.length > 0; }',
        isBinary: false,
      },
    } as FileMap;

    const result = await runSearchText({
      input: { query: 'verifyWebhook', context: 'repair webhook signature verification' },
      files,
      recentFileWrites: new Map([[recentPath, 10]]),
    });
    const records = (result.data as { records: Array<Record<string, unknown>> }).records;

    expect(records[0]).toMatchObject({ path: definitionPath, line: 1 });
    expect(records[0].fileRevision).toMatch(/^[a-f0-9]{16}$/);
    expect(records[0].relevance).toEqual(expect.any(Number));
  });

  test('reacquires an old build-task fact that the recency-only baseline misses within one bounded page', async () => {
    const targetPath = getAbsolutePath('src/server/checkout.ts');
    const recentPaths = Array.from({ length: 20 }, (_, index) => getAbsolutePath(`src/routes/recent-${index}.tsx`));
    const files = Object.fromEntries([
      [targetPath, { type: 'file', content: 'export function reconcileCheckoutSession() {}', isBinary: false }],
      ...recentPaths.map(
        (filePath, index) =>
          [filePath, { type: 'file', content: `export const recent${index} = true;`, isBinary: false }] as const,
      ),
    ]) as FileMap;
    const recentWrites = new Map(recentPaths.map((filePath, index) => [filePath, index]));
    const baselineTop16 = Array.from(recentWrites)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 16);

    const result = await runSearchText({
      input: { query: 'reconcileCheckoutSession', context: 'fix checkout build failure' },
      files,
      recentFileWrites: recentWrites,
    });
    const records = (result.data as { records: Array<{ path: string }> }).records;

    expect(baselineTop16.some(([filePath]) => filePath === targetPath)).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].path).toBe(targetPath);
    expect(result.coverage).toMatchObject({ complete: true, total: 1 });
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(TOOL_PAGE_SERIALIZED_CHARACTERS);
  });

  test('honors cancellation before repository discovery starts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      runSearchText({ input: { query: 'anything' }, files: {}, abortSignal: controller.signal }),
    ).rejects.toThrow('cancelled');
  });
});
