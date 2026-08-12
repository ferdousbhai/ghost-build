import { describe, expect, it } from 'vitest';
import { workspaceHintsToTurnContext } from './fileUtils';

describe('fileUtils', () => {
  it('renders paths without duplicating file contents', () => {
    expect(
      workspaceHintsToTurnContext({
        currentFile: '/home/project/src/index.ts',
        changedFiles: ['/home/project/src/styles.css', '/home/project/src/index.ts'],
      }),
    ).toBe(
      `Current editor file: "/home/project/src/index.ts"

User-modified durable workspace files; read relevant files before editing:
- "/home/project/src/index.ts"
- "/home/project/src/styles.css"`,
    );
  });

  it('keeps workspace hints within their character budget', () => {
    const result = workspaceHintsToTurnContext(
      { changedFiles: Array.from({ length: 100 }, (_, index) => `/home/project/src/file-${index}.ts`) },
      300,
    );

    expect(result.length).toBeLessThanOrEqual(300);
    expect(result).toMatch(/^User-modified durable workspace files/);
    expect(result).toContain('more modified files');
  });

  it('quotes unusual file paths', () => {
    const result = workspaceHintsToTurnContext({ changedFiles: ['src/a"&b.ts'] });

    expect(result).toContain('- "src/a\\"&b.ts"');
  });
});
