import { describe, expect, test } from 'vitest';
import type { UIMessage } from 'ai';
import { MAX_USER_MESSAGE_TEXT_CHARS, sanitizePersistedChatMessage } from '../template/src/agents/chat-policy';

describe('generated Agent chat policy', () => {
  test('keeps trusted assistant text while removing persistence-only metadata', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'response' }],
    } satisfies UIMessage;

    expect(sanitizePersistedChatMessage(message)).toEqual(message);
  });

  test('bounds user text across parts and removes unsupported client parts', () => {
    const message = {
      id: `message-${'x'.repeat(256)}`,
      role: 'user',
      metadata: { untrusted: 'metadata' },
      parts: [
        { type: 'text', text: 'a'.repeat(MAX_USER_MESSAGE_TEXT_CHARS - 2) },
        { type: 'file', mediaType: 'text/plain', url: 'https://attacker.example/file' },
        { type: 'text', text: 'bcdef' },
      ],
    } satisfies UIMessage;

    const sanitized = sanitizePersistedChatMessage(message);

    expect(sanitized.id).toHaveLength(128);
    expect(sanitized).not.toHaveProperty('metadata');
    expect(sanitized.parts).toEqual([{ type: 'text', text: `${'a'.repeat(MAX_USER_MESSAGE_TEXT_CHARS - 2)}bc` }]);
  });
});
