import { describe, expect, it } from 'vitest';
import { stripIndents } from './stripIndent.js';

describe('stripIndents', () => {
  it('strips shared indentation and blank outer lines from strings', () => {
    expect(
      stripIndents(`
        first
          second
      `),
    ).toBe('first\n  second');
  });

  it('interpolates template values before stripping indentation', () => {
    const value = 'second';
    expect(stripIndents`
      first
      ${value}
    `).toBe('first\nsecond');
  });
});
