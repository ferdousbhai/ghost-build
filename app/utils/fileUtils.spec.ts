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

  it('keeps modified-file context valid and within its character budget', () => {
    const result = filesToArtifacts(
      {
        'src/large.ts': { content: 'x'.repeat(5_000) },
        'src/small.ts': { content: 'export const ready = true;' },
      },
      'changes',
      300,
    );

    expect(result.length).toBeLessThanOrEqual(300);
    expect(result).toMatch(/^<boltArtifact/);
    expect(result).toMatch(/<\/boltArtifact>$/);
    expect(result).toContain('src/large.ts');
    expect(result).toContain('use view to inspect');
  });

  it('escapes artifact and file path attributes', () => {
    const result = filesToArtifacts({ 'src/a"&b.ts': { content: 'export {};' } }, 'id"&');

    expect(result).toContain('id="id&quot;&amp;"');
    expect(result).toContain('filePath="src/a&quot;&amp;b.ts"');
  });
});
