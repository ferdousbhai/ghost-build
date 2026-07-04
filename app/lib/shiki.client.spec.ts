import { describe, expect, it } from 'vitest';
import { normalizeCodeLanguage } from './shiki.client';

describe('normalizeCodeLanguage', () => {
  it.each([
    ['.ts', 'typescript'],
    ['JS', 'javascript'],
    ['yml', 'yaml'],
    ['unknown', 'plaintext'],
  ] as const)('normalizes %s to %s', (input, expected) => {
    expect(normalizeCodeLanguage(input)).toBe(expected);
  });
});
