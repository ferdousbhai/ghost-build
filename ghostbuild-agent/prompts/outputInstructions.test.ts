import { describe, expect, it } from 'vitest';
import { outputInstructions } from './outputInstructions.js';

describe('Ghostbuild filesystem output instructions', () => {
  it('preserves the TanStack file-route export when replacing the primary page', () => {
    const prompt = outputInstructions();

    expect(prompt).toContain('export const Route = createFileRoute(...)');
    expect(prompt).toContain('never replace a TanStack file route with only a default export');
  });

  it('grounds line edits in read snapshots and reserves exec for filesystem operations', () => {
    const prompt = outputInstructions();

    expect(prompt).toContain('read returns numbered lines and a base snapshot tag');
    expect(prompt).toContain('startLine/endLine');
    expect(prompt).toContain('mkdir, mv, and rm');
    expect(prompt).toContain('shell text rewriting when write or edit');
    expect(prompt).toContain('pnpm install --lockfile-only');
    expect(prompt).toContain('/home/project/.ghost/docs/index.md');
    expect(prompt).toContain('validates after each source or dependency mutation');
  });
});
