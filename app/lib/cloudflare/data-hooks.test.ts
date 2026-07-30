import { describe, expect, it } from 'vitest';
import { subchatQueryKey } from './data-hooks';

describe('subchatQueryKey', () => {
  it('matches the cache entry used by subchat history queries', () => {
    expect(subchatQueryKey({ chatId: 'chat-1', sessionId: 'user-1' })).toEqual([
      'ghostbuild-data',
      'subchats.get',
      { chatId: 'chat-1', sessionId: 'user-1' },
    ]);
    expect(subchatQueryKey('skip')).toEqual(['ghostbuild-data', 'subchats.get', 'skip']);
  });
});
