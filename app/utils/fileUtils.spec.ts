import { describe, expect, it } from 'vitest';
import { WORK_DIR } from 'ghostbuild-agent/constants';
import { filesToArtifacts, workDirRelative } from './fileUtils';

describe('fileUtils', () => {
  it('converts workspace paths to relative paths', () => {
    expect(workDirRelative(WORK_DIR)).toBe('');
    expect(workDirRelative(`${WORK_DIR}/src/index.ts`)).toBe('src/index.ts');
  });

  it('keeps existing relative paths unchanged', () => {
    expect(workDirRelative('src/index.ts')).toBe('src/index.ts');
  });

  it('renders modified files as artifact actions without wrapper whitespace', () => {
    expect(filesToArtifacts({ 'src/index.ts': { content: 'export const value = 1;' } }, 'changes')).toBe(
      `<boltArtifact id="changes" title="User Updated Files">
<boltAction type="file" filePath="src/index.ts">
export const value = 1;
</boltAction>
</boltArtifact>`,
    );
  });
});
