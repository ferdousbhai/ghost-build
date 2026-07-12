import { describe, expect, test, vi } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import {
  AUTO_COMPACTION_TOKEN_THRESHOLD,
  assembleCompactedContext,
  compactContext,
  createEmergencyContext,
  estimateContextTokens,
  shouldCompactContext,
  toSessionMessages,
  type ContextCompaction,
} from './context-compaction';

function textMessage(id: string, role: 'user' | 'assistant', text: string): GhostbuildMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

function longConversation(count = 24): GhostbuildMessage[] {
  return Array.from({ length: count }, (_, index) =>
    textMessage(`m-${index}`, index % 2 === 0 ? 'user' : 'assistant', `${index}:${'x'.repeat(20_000)}`),
  );
}

describe('Cloudflare-native context compaction', () => {
  test('triggers compaction only when the estimated token threshold is exceeded', () => {
    expect(shouldCompactContext(AUTO_COMPACTION_TOKEN_THRESHOLD + 1)).toBe(true);
    expect(shouldCompactContext(AUTO_COMPACTION_TOKEN_THRESHOLD)).toBe(false);
  });

  test('applies a summary as a non-destructive read-time overlay', () => {
    const messages = Array.from({ length: 8 }, (_, index) => textMessage(`m-${index}`, 'user', `turn ${index}`));
    const compaction: ContextCompaction = {
      summary: '## Current State\nThe app shell is complete.',
      fromMessageId: 'm-2',
      toMessageId: 'm-5',
      generation: 1,
    };

    const assembled = assembleCompactedContext(messages, compaction);

    expect(messages).toHaveLength(8);
    expect(assembled.overlayApplied).toBe(true);
    expect(assembled.messages.map((message) => message.id)).toEqual([
      'm-0',
      'm-1',
      'compaction_ghostbuild_1',
      'm-6',
      'm-7',
    ]);
    expect(assembled.messages[2].parts).toEqual([{ type: 'text', text: compaction.summary }]);
  });

  test('does not apply an overlay when a rewind removed its end anchor', () => {
    const messages = Array.from({ length: 4 }, (_, index) => textMessage(`m-${index}`, 'user', `turn ${index}`));
    const assembled = assembleCompactedContext(messages, {
      summary: 'Summary from a later branch',
      fromMessageId: 'm-1',
      toMessageId: 'm-9',
      generation: 2,
    });

    expect(assembled.overlayApplied).toBe(false);
    expect(assembled.messages).toBe(messages);
  });

  test('creates and iteratively updates Cloudflare summaries', async () => {
    const messages = longConversation();
    const firstSummarize = vi.fn(
      async (_prompt: string) => '## Topic\nBuild an app\n\n## Current State\nInitial work complete.',
    );
    const first = await compactContext({
      messages,
      summarize: firstSummarize,
    });

    expect(first).not.toBeNull();
    expect(first?.generation).toBe(1);
    expect(firstSummarize).toHaveBeenCalledOnce();
    expect(firstSummarize.mock.calls[0][0]).toContain('## Open Items');

    const extended = [
      ...messages,
      ...Array.from({ length: 12 }, (_, index) =>
        textMessage(`new-${index}`, index % 2 === 0 ? 'user' : 'assistant', `new:${'y'.repeat(20_000)}`),
      ),
    ];
    const secondSummarize = vi.fn(
      async (_prompt: string) => '## Topic\nBuild an app\n\n## Current State\nNew work complete.',
    );
    const second = await compactContext({
      messages: extended,
      current: first,
      summarize: secondSummarize,
    });

    expect(second).not.toBeNull();
    expect(second?.generation).toBe(2);
    expect(second?.fromMessageId).toBe(first?.fromMessageId);
    expect(secondSummarize.mock.calls[0][0]).toContain('PREVIOUS SUMMARY');
    expect(secondSummarize.mock.calls[0][0]).toContain(first?.summary);
  });

  test('retains early requirements across three compaction generations', async () => {
    const markers = ['REQ_EDGE_ONLY', 'REQ_NO_THINK', 'REQ_COMPACT_100K'];
    let messages = longConversation().map((message, index) => {
      const markerIndex = [5, 8, 11].indexOf(index);
      return markerIndex < 0
        ? message
        : textMessage(
            message.id,
            message.role as 'user' | 'assistant',
            `${markers[markerIndex]}:${'x'.repeat(20_000)}`,
          );
    });
    const originalMessages = [...messages];
    let current: ContextCompaction | null = null;

    for (let generation = 1; generation <= 3; generation += 1) {
      const next = await compactContext({
        messages,
        current,
        summarize: async () => `Generation ${generation} summary preserving ${markers.join(', ')}.`,
      });
      expect(next?.generation).toBe(generation);
      current = next;
      const assembled = assembleCompactedContext(messages, current).messages;
      const rendered = JSON.stringify(assembled);
      for (const marker of markers) {
        expect(rendered.match(new RegExp(marker, 'g'))).toHaveLength(1);
      }
      expect(assembled.some((message) => ['m-5', 'm-8', 'm-11'].includes(message.id))).toBe(false);
      messages = [
        ...messages,
        ...Array.from({ length: 12 }, (_, index) =>
          textMessage(
            `generation-${generation}-${index}`,
            index % 2 === 0 ? 'user' : 'assistant',
            `${generation}:${'z'.repeat(20_000)}`,
          ),
        ),
      ];
    }

    expect(originalMessages).toEqual(messages.slice(0, originalMessages.length));
    expect(
      markers.every((marker) => JSON.stringify(assembleCompactedContext(messages, current).messages).includes(marker)),
    ).toBe(true);
  });

  test('normalizes legacy tool results for Cloudflare token accounting', () => {
    const messages: GhostbuildMessage[] = [
      {
        id: 'tool-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'call-1',
              toolName: 'view',
              args: { path: '/src/app.ts' },
              result: 'z'.repeat(4_000),
            },
          },
        ],
      },
    ];

    const normalized = toSessionMessages(messages);
    expect(normalized[0].parts[0]).toMatchObject({
      type: 'dynamic-tool',
      toolCallId: 'call-1',
      toolName: 'view',
      output: expect.any(String),
    });
    expect(estimateContextTokens(messages)).toBeGreaterThan(900);
  });

  test('keeps protected head and recent tail when summary generation is unavailable', () => {
    const messages = longConversation(40);
    const emergency = createEmergencyContext(messages);

    expect(emergency.length).toBeLessThan(messages.length);
    expect(emergency.slice(0, 3).map((message) => message.id)).toEqual(['m-0', 'm-1', 'm-2']);
    expect(emergency.at(-1)?.id).toBe(messages.at(-1)?.id);
    expect(emergency.some((message) => message.id === 'compaction_ghostbuild_emergency')).toBe(true);
    expect(messages).toHaveLength(40);
  });
});
