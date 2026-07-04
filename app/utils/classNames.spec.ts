import { describe, expect, it } from 'vitest';
import { classNames } from './classNames';

describe('classNames', () => {
  it('joins strings, conditional objects, and nested arrays', () => {
    expect(classNames('base', { active: true, hidden: false }, ['nested', { selected: true }], undefined)).toBe(
      'base active nested selected',
    );
  });
});
