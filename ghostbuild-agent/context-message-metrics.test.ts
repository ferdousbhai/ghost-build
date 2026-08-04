import { describe, expect, test } from 'vitest';
import type { GhostbuildMessage } from './ai-compat.js';
import { calculatePromptCharacterCounts } from './context-message-metrics.js';

describe('calculatePromptCharacterCounts', () => {
  test('counts text from native message parts', () => {
    const messages: GhostbuildMessage[] = [
      {
        id: 'history',
        role: 'assistant',
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
        parts: [
          {
            type: 'tool-read',
            state: 'output-available',
            toolCallId: 'call',
            input: { path: 'a' },
            output: 'ok',
          },
        ],
      },
    ];

    expect(calculatePromptCharacterCounts(messages).messageHistoryChars).toBeGreaterThan(0);
  });

  test('uses text parts for the current turn', () => {
    const messages: GhostbuildMessage[] = [
      {
        id: 'turn',
        role: 'user',
        parts: [{ type: 'text', text: 'modern text' }],
      },
    ];

    expect(calculatePromptCharacterCounts(messages).currentTurnChars).toBe(11);
  });
});
