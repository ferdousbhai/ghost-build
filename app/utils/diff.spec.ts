import { describe, expect, it } from 'vitest';
import { getAbsolutePath, getRelativePath } from 'ghostbuild-agent/utils/workDir';
import { WORK_DIR } from 'ghostbuild-agent/constants';
import { computeFileModifications } from './diff';
import type { FileMap } from 'ghostbuild-agent/types';

describe('Diff', () => {
  it('should strip out Work_dir', () => {
    const filePath = `${WORK_DIR}/index.js`;
    const result = getRelativePath(filePath);
    expect(result).toBe('index.js');
  });

  it('returns undefined when modified files match current files', () => {
    const filePath = getAbsolutePath('index.js');
    const files = {} as FileMap;
    files[filePath] = { type: 'file', content: 'const value = 1;\n', isBinary: false };

    expect(computeFileModifications(files, new Map([[filePath, 'const value = 1;\n']]))).toBeUndefined();
  });

  it('returns a modification entry when file contents changed', () => {
    const filePath = getAbsolutePath('index.js');
    const files = {} as FileMap;
    files[filePath] = { type: 'file', content: 'const value = 2;\n', isBinary: false };

    expect(computeFileModifications(files, new Map([[filePath, 'const value = 1;\n']]))).toEqual({
      [filePath]: {
        type: 'file',
        content: 'const value = 2;\n',
      },
    });
  });
});
