import { describe, expect, it } from 'vitest';
import { summarize } from './summarize';

describe('summarize', () => {
  it('recursively truncates strings in objects and arrays', () => {
    expect(
      summarize(
        {
          title: 'abcdef',
          nested: [{ value: 'ghijkl' }],
          count: 2,
        },
        3,
      ),
    ).toEqual({
      title: 'abc...',
      nested: [{ value: 'ghi...' }],
      count: 2,
    });
  });
});
