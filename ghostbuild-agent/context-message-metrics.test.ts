import { describe, expect, test } from 'vitest';
import type { GhostbuildMessage } from './ai-compat.js';
import { calculatePromptCharacterCounts } from './context-message-metrics.js';

describe('calculatePromptCharacterCounts', () => {
  test('does not count legacy content and mirrored text parts twice', () => {
    const messages: GhostbuildMessage[] = [
      {
        id: 'history',
        role: 'assistant',
        content: 'stored text',
        parts: [{ type: 'text', text: 'stored text' }],
      },
      {
        id: 'turn',
        role: 'user',
        parts: [{ type: 'text', text: 'next' }],
      },
    ];

    expect(calculatePromptCharacterCounts(messages, ['system'])).toEqual({
      messageHistoryChars: 11,
      currentTurnChars: 4,
      totalPromptChars: 21,
    });
  });

  test('includes non-text tool payloads once', () => {
    const messages: GhostbuildMessage[] = [
      {
        id: 'tool',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'call',
              toolName: 'view',
              args: { path: 'a' },
              result: 'ok',
            },
          },
        ],
      },
    ];

    expect(calculatePromptCharacterCounts(messages).messageHistoryChars).toBeGreaterThan(0);
  });

  test('uses text parts when a modern message carries an empty legacy content field', () => {
    const messages: GhostbuildMessage[] = [
      {
        id: 'turn',
        role: 'user',
        content: '',
        parts: [{ type: 'text', text: 'modern text' }],
      },
    ];

    expect(calculatePromptCharacterCounts(messages).currentTurnChars).toBe(11);
  });
});
