import { describe, expect, test } from 'vitest';
import type { FileMap } from 'ghostbuild-agent/types';
import { buildFileList, folderPathsFromFileList, visibleFileList } from './file-tree-model';

const files = {
  '/home/project/src/z.ts': { type: 'file', content: '' },
  '/home/project/src/components/Button.tsx': { type: 'file', content: '' },
  '/home/project/src/a.ts': { type: 'file', content: '' },
  '/home/project/node_modules/pkg/index.js': { type: 'file', content: '' },
} as FileMap;

describe('file tree model', () => {
  test('builds a stable folder-first depth-first list', () => {
    const nodes = buildFileList(files, '/home/project', false, [/\/node_modules\//]);
    expect(nodes.map((node) => [node.kind, node.fullPath, node.depth])).toEqual([
      ['folder', '/home/project', 0],
      ['folder', '/home/project/src', 1],
      ['folder', '/home/project/src/components', 2],
      ['file', '/home/project/src/components/Button.tsx', 3],
      ['file', '/home/project/src/a.ts', 2],
      ['file', '/home/project/src/z.ts', 2],
    ]);
  });

  test('uses root-relative depths when the selected root is hidden', () => {
    const nodes = buildFileList(files, '/home/project/src', true, []);
    expect(nodes.map((node) => [node.fullPath, node.depth])).toEqual([
      ['/home/project/src/components', 0],
      ['/home/project/src/components/Button.tsx', 1],
      ['/home/project/src/a.ts', 0],
      ['/home/project/src/z.ts', 0],
    ]);
  });

  test('filters descendants of collapsed folders without changing the model', () => {
    const nodes = buildFileList(files, '/home/project', false, []);
    const visible = visibleFileList(nodes, new Set(['/home/project/src/components']));
    expect(visible.map((node) => node.fullPath)).not.toContain('/home/project/src/components/Button.tsx');
    expect(folderPathsFromFileList(nodes)).toContain('/home/project/src/components');
    expect(nodes.some((node) => node.fullPath === '/home/project/src/components/Button.tsx')).toBe(true);
  });
});
