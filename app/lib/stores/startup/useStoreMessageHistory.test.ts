import { describe, expect, test } from 'vitest';
import { getLastCompletePart } from './useStoreMessageHistory';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

function createMessage(overrides: Partial<GhostbuildMessage> = {}): GhostbuildMessage {
  return {
    id: `test-${Math.random()}`,
    role: 'user',
    parts: [
      {
        type: 'text',
        text: 'test',
      },
    ],
    createdAt: new Date(),
    ...overrides,
  };
}

function createToolInvocationPart(
  invocation:
    { state: 'output-available'; output: string } | { state: 'input-streaming' } | { state: 'input-available' },
) {
  return {
    type: 'dynamic-tool' as const,
    toolName: 'test',
    toolCallId: `test-${Math.random()}`,
    input: null,
    ...invocation,
  };
}

describe('getLastCompletePart', () => {
  test('returns the last complete part', () => {
    const message = createMessage({
      role: 'user',
      parts: [
        {
          type: 'text',
          text: 'test',
        },
      ],
    });
    const lastCompletePart = getLastCompletePart([message], 'submitted');

    expect(lastCompletePart).toEqual({
      messageIndex: 0,
      partIndex: 0,
      hasNextPart: false,
    });
  });

  test('returns null if there are no parts', () => {
    const lastCompletePart = getLastCompletePart([], 'submitted');

    expect(lastCompletePart).toBeNull();
  });

  test('returns null if the last part is not complete', () => {
    const assistantMessage = createMessage({
      role: 'assistant',
      parts: [
        {
          type: 'text',
          text: 'test',
        },
      ],
    });
    const lastCompletePart = getLastCompletePart([assistantMessage], 'streaming');

    expect(lastCompletePart).toBeNull();
  });

  test('returns previous part if the last part is incomplete text part', () => {
    const userMessage = createMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'test' }],
    });
    const assistantMessage = createMessage({
      role: 'assistant',
      parts: [
        createToolInvocationPart({ state: 'output-available', output: 'something' }),
        { type: 'text', text: 'test' },
      ],
    });
    const lastCompletePart = getLastCompletePart([userMessage, assistantMessage], 'streaming');

    expect(lastCompletePart).toEqual({
      messageIndex: 1,
      partIndex: 0,
      hasNextPart: true,
    });
  });

  test('returns previous part if the last part is incomplete tool invocation part', () => {
    const messageA = createMessage({
      role: 'assistant',
      parts: [{ type: 'text', text: 'test' }, createToolInvocationPart({ state: 'input-streaming' })],
    });
    const lastCompletePart = getLastCompletePart([messageA], 'streaming');

    expect(lastCompletePart).toEqual({
      messageIndex: 0,
      partIndex: 0,
      hasNextPart: true,
    });
  });

  test('returns previous part if there are empty messages', () => {
    const message1 = createMessage({
      role: 'assistant',
      parts: [
        { type: 'text', text: 'test' },
        createToolInvocationPart({ state: 'output-available', output: 'something' }),
      ],
    });
    const message2 = createMessage({
      role: 'assistant',
      parts: [],
    });
    const lastCompletePart = getLastCompletePart([message1, message2], 'streaming');

    expect(lastCompletePart).toEqual({
      messageIndex: 0,
      partIndex: 1,
      hasNextPart: true,
    });
  });
});
