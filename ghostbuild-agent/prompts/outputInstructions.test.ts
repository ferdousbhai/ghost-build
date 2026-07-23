import { describe, expect, it } from 'vitest';
import { outputInstructions } from './outputInstructions.js';

describe('Ghostbuild filesystem output instructions', () => {
  it('preserves the TanStack file-route export when replacing the primary page', () => {
    const prompt = outputInstructions();

    expect(prompt).toContain('export const Route = createFileRoute(...)');
    expect(prompt).toContain('never replace a TanStack file route with only a default export');
  });
});
