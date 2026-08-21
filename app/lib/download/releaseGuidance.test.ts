import { describe, expect, test } from 'vitest';
import { cursorRulesContent } from './cursorRulesContent';
import { generateReadmeContent } from './readmeContent';

describe('generated project release guidance', () => {
  test.each([
    ['README', generateReadmeContent('Example')],
    ['Cursor rules', cursorRulesContent],
  ])('%s requires refreshed dependency notices before build or deploy', (_label, content) => {
    expect(content).toContain('pnpm run licenses:generate');
    expect(content).toContain('production dependenc');
    expect(content).toContain('build');
    expect(content).toContain('deploy');
  });

  test('Cursor rules embed the stack-selection skill body without its frontmatter', () => {
    expect(cursorRulesContent).toContain('ghostbuild.projectType to "worker"');
    expect(cursorRulesContent).toContain('TanStack Query or TanStack DB only when');
    expect(cursorRulesContent).not.toContain('name: project-stack');
    expect(cursorRulesContent).not.toContain('---');
  });
});
