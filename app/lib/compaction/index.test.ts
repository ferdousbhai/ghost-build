import { describe, expect, it } from 'vitest';
import { canApplyConversationCompaction, conversationCompactionKey } from './index';

describe('conversation compaction policy', () => {
  it('builds stable scope-bound keys', () => {
    expect(conversationCompactionKey({ scope: 'agent/one', throughId: 'message 2', revision: 3 })).toBe(
      'conversation-compaction:agent%2Fone:message%202:3',
    );
  });

  it('only applies snapshots that advance the current compacted boundary', () => {
    const currentMessageIds = ['a', 'b', 'c', 'd'];
    expect(canApplyConversationCompaction({ expectedFromId: 'a', expectedThroughId: 'c', currentMessageIds })).toBe(
      true,
    );
    expect(
      canApplyConversationCompaction({
        expectedFromId: 'a',
        expectedThroughId: 'c',
        currentMessageIds,
        currentThroughId: 'b',
      }),
    ).toBe(true);
    expect(
      canApplyConversationCompaction({
        expectedFromId: 'a',
        expectedThroughId: 'c',
        currentMessageIds,
        currentThroughId: 'd',
      }),
    ).toBe(false);
  });
});
