import { describe, expect, it } from 'vitest';
import { renderFile } from './renderFile.js';

describe('renderFile', () => {
  it('adds one-indexed line numbers', () => {
    expect(renderFile('first\nsecond')).toBe('1: first\n2: second');
  });
});
