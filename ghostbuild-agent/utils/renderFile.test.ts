import { describe, expect, it } from 'vitest';
import { renderFile } from './renderFile.js';

describe('renderFile', () => {
  it('adds one-indexed line numbers', () => {
    expect(renderFile('first\nsecond')).toBe('1: first\n2: second');
  });

  it('renders one-indexed inclusive ranges', () => {
    expect(renderFile('first\nsecond\nthird', [2, 3])).toBe('2: second\n3: third');
  });

  it('uses -1 as the end-of-file range sentinel', () => {
    expect(renderFile('first\nsecond\nthird', [2, -1])).toBe('2: second\n3: third');
  });
});
