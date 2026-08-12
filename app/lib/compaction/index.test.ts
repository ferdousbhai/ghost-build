import { describe, expect, it } from 'vitest';
import { canApplyConversationCompaction, conversationCompactionKey, decideConversationCompaction } from './index';

const policy = {
  proactiveTokens: 75_000,
  hardLimitTokens: 100_000,
  headroomTokens: 1_000,
};

describe('conversation compaction policy', () => {
  it('selects none, background, and blocking at the configured boundaries', () => {
    expect(decideConversationCompaction({ estimatedTokens: 70_000, policy })).toBe('none');
    expect(decideConversationCompaction({ estimatedTokens: 76_000, policy })).toBe('background');
    expect(decideConversationCompaction({ estimatedTokens: 99_000, policy })).toBe('blocking');
    expect(decideConversationCompaction({ estimatedTokens: 76_000, pending: true, policy })).toBe('none');
  });

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
