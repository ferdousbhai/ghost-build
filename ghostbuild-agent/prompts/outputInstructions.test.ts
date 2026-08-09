import { describe, expect, it } from 'vitest';
import { outputInstructions } from './outputInstructions.js';

describe('Ghostbuild filesystem output instructions', () => {
  it('preserves the TanStack file-route export when replacing the primary page', () => {
    const prompt = outputInstructions();

    expect(prompt).toContain('export const Route = createFileRoute(...)');
    expect(prompt).toContain('never replace a TanStack file route with only a default export');
  });

  it('keeps source mutation explicit while routing safe dependency commands through exec', () => {
    const prompt = outputInstructions();

    expect(prompt).toContain('Do not use exec to mutate project source or configuration');
    expect(prompt).toContain('Use write or edit for source changes');
    expect(prompt).toContain('pnpm install --lockfile-only');
    expect(prompt).toContain('/home/project/.ghost/docs/index.md');
    expect(prompt).toContain('Ghostbuild automatically');
    expect(prompt).toContain('validates after each source or dependency mutation');
  });
});
