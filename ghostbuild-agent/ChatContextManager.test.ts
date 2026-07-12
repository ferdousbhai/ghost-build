import { describe, expect, test } from 'vitest';
import { ChatContextManager } from './ChatContextManager.js';
import type { FileMap } from './types.js';
import type { AbsolutePath } from './utils/workDir.js';

describe('ChatContextManager', () => {
  test('builds a bounded relevant-file message for every turn', () => {
    const filePath = '/home/project/src/app.ts' as AbsolutePath;
    const files: FileMap = {
      [filePath]: { type: 'file', content: 'export const app = true;', isBinary: false },
    };
    const manager = new ChatContextManager(
      () => ({ filePath, value: 'export const app = true;', isBinary: false }),
      () => files,
      () => new Map(),
    );

    const first = manager.relevantFiles([], 'turn-1', 2_000);
    const second = manager.relevantFiles([], 'turn-2', 2_000);

    expect(JSON.stringify(first.parts)).toContain('src/app.ts');
    expect(JSON.stringify(second.parts)).toContain('src/app.ts');
  });
});
