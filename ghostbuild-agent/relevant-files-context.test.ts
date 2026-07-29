import { describe, expect, test } from 'vitest';
import { RelevantFilesContext } from './relevant-files-context.js';
import type { EditorDocument, FileMap } from './types.js';
import { getAbsolutePath } from './utils/workDir.js';

describe('RelevantFilesContext', () => {
  test('keeps the complete context message within its character budget', () => {
    const currentDocument: EditorDocument = {
      filePath: getAbsolutePath('src/current.ts'),
      value: 'x'.repeat(2_000),
      isBinary: false,
    };
    const files = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        getAbsolutePath(`src/path-${index}.ts`),
        { type: 'file', content: `export const value${index} = ${index};`, isBinary: false },
      ]),
    ) as FileMap;
    const context = new RelevantFilesContext(
      () => currentDocument,
      () => files,
      () => new Map(),
    );

    const message = context.build([], 'context', 500);

    expect(message.parts).toHaveLength(1);
    const part = message.parts[0];
    expect(part.type).toBe('text');
    if (part.type === 'text') {
      expect(part.text.length).toBeLessThanOrEqual(500);
      expect(part.text).toMatch(/^Relevant workspace context:/);
      expect(part.text).toContain('more paths');
    }
  });

  test('quotes unusual file paths without legacy artifact markup', () => {
    const filePath = getAbsolutePath('src/a"&b.ts');
    const context = new RelevantFilesContext(
      () => ({ filePath, value: 'export {};', isBinary: false }),
      () => ({ [filePath]: { type: 'file', content: 'export {};', isBinary: false } }),
      () => new Map(),
    );

    const message = context.build([], 'context', 1_000);
    const part = message.parts[0];
    expect(part.type).toBe('text');
    if (part.type === 'text') {
      expect(part.text).toContain('File "/home/project/src/a\\"&b.ts":');
      expect(part.text).not.toContain('boltArtifact');
    }
  });
});
