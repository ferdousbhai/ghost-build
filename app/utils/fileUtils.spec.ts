import { describe, expect, it } from 'vitest';
import { filesToTurnContext } from './fileUtils';

describe('fileUtils', () => {
  it('renders modified files as plain bounded workspace context', () => {
    expect(filesToTurnContext({ 'src/index.ts': { content: 'export const value = 1;' } })).toBe(
      `User-modified workspace files:
File "src/index.ts":
export const value = 1;`,
    );
  });

  it('keeps modified-file context valid and within its character budget', () => {
    const result = filesToTurnContext(
      {
        'src/large.ts': { content: 'x'.repeat(5_000) },
        'src/small.ts': { content: 'export const ready = true;' },
      },
      300,
    );

    expect(result.length).toBeLessThanOrEqual(300);
    expect(result).toMatch(/^User-modified workspace files:/);
    expect(result).toContain('src/large.ts');
    expect(result).toContain('use read to inspect');
  });

  it('quotes unusual file paths without legacy artifact markup', () => {
    const result = filesToTurnContext({ 'src/a"&b.ts': { content: 'export {};' } });

    expect(result).toContain('File "src/a\\"&b.ts":');
    expect(result).not.toContain('boltArtifact');
  });
});
