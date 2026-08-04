import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { MAX_ESTIMATED_MODEL_INPUT_TOKENS } from 'ghostbuild-agent/context-limits';
import type { GhostbuildToolSet } from 'ghostbuild-agent/types';
import { ModelInputBudgetExceededError, prepareModelInput } from './model-input';
import type { ContextCompactionUnavailableError } from './model-input';

const tools = {
  read: { description: 'Read a file', inputSchema: z.object({ path: z.string() }) },
  write: {
    description: 'Write a file with a deliberately longer definition',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  },
} as unknown as GhostbuildToolSet;

function message(id: string, text: string): GhostbuildMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

function largeHistory(count = 48): GhostbuildMessage[] {
  return Array.from({ length: count }, (_, index) => message(`m-${index}`, 'x'.repeat(20_000)));
}

function prepare(messages: GhostbuildMessage[], options: Partial<Parameters<typeof prepareModelInput>[0]> = {}) {
  return prepareModelInput({
    messages,
    summarize: async () => '## Current State\nCompacted.',
    systemPrompts: [],
    tools,
    toolChoice: 'auto',
    ...options,
  });
}

describe('prepareModelInput', () => {
  test('builds small provider inputs once with complete history', async () => {
    const summarize = vi.fn(async () => 'summary');
    const messages = [message('old-user', 'earlier requirement'), message('current-user', 'Build it')];

    const result = await prepare(messages, { summarize, systemPrompts: ['System'] });

    expect(result.contextCompacted).toBe(false);
    expect(result.nextCompaction).toBeNull();
    expect(result.promptMessages).toBe(messages);
    expect(result.messages.map((item) => item.role)).toEqual(['system', 'user', 'user']);
    expect(JSON.stringify(result.messages)).toContain('earlier requirement');
    expect(summarize).not.toHaveBeenCalled();
  });

  test('estimates only tool definitions enabled for the provider call', async () => {
    const allTools = await prepare([message('user-1', 'Inspect it')]);
    const readOnly = await prepare([message('user-1', 'Inspect it')], {
      toolChoice: 'required',
      activeTools: ['read'],
    });

    expect(readOnly.estimatedTokens).toBeLessThan(allTools.estimatedTokens);
  });

  test('compacts once after the actual provider input crosses 100K', async () => {
    const result = await prepare(largeHistory());

    expect(result.nextCompaction?.summary).toContain('Compacted');
    expect(result.contextCompacted).toBe(true);
    expect(result.promptMessages.length).toBeLessThan(48);
    expect(result.estimatedTokens).toBeLessThanOrEqual(MAX_ESTIMATED_MODEL_INPUT_TOKENS);
  });

  test('accepts proactive compaction without waiting for summary generation', async () => {
    const summarize = vi.fn(async () => 'summary');
    const scheduleCompaction = vi.fn(async () => undefined);
    const result = await prepare(largeHistory(18), { scheduleCompaction, summarize });

    expect(result.compactionAction).toBe('background');
    expect(scheduleCompaction).toHaveBeenCalledOnce();
    expect(summarize).not.toHaveBeenCalled();
    expect(result.nextCompaction).toBeNull();
  });

  test('does not schedule another proactive compaction while one is pending', async () => {
    const summarize = vi.fn(async () => 'summary');
    const scheduleCompaction = vi.fn(async () => undefined);
    const result = await prepare(largeHistory(18), {
      compactionPending: true,
      scheduleCompaction,
      summarize,
    });

    expect(result.compactionAction).toBe('none');
    expect(scheduleCompaction).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });

  test('counts turn-local context but never places it in the persisted summary prompt', async () => {
    const summarize = vi.fn(async (_prompt: string) => 'durable summary');
    const messages = Array.from({ length: 20 }, (_, index) => message(`m-${index}`, 'x'.repeat(18_000)));
    const turnContext = {
      version: 1 as const,
      content: `ephemeral-workspace:${'y'.repeat(79_000)}`,
    };

    const result = await prepare(messages, { summarize, turnContext });

    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize.mock.calls[0]?.[0]).not.toContain('ephemeral-workspace');
    expect(result.nextCompaction?.summary).toBe('durable summary');
    expect(JSON.stringify(result.promptMessages)).toContain('ephemeral-workspace');
    expect(JSON.stringify(messages)).not.toContain('ephemeral-workspace');
  });

  test('iteratively updates an existing summary overlay', async () => {
    const first = await prepare(largeHistory());
    const extended = [
      ...largeHistory(),
      ...Array.from({ length: 12 }, (_, index) => message(`new-${index}`, 'y'.repeat(20_000))),
    ];

    const second = await prepare(extended, {
      currentCompaction: first.nextCompaction,
      summarize: async () => 'updated summary',
    });

    expect(second.contextCompacted).toBe(true);
    expect(second.nextCompaction?.summary).toBe('updated summary');
    expect(second.nextCompaction?.fromMessageId).toBe(first.nextCompaction?.fromMessageId);
  });

  test('fails clearly without mutating or omitting history when summary generation fails', async () => {
    const messages = largeHistory();
    const original = structuredClone(messages);

    await expect(
      prepare(messages, {
        summarize: async () => {
          throw new Error('summary unavailable');
        },
      }),
    ).rejects.toMatchObject({
      name: 'ContextCompactionUnavailableError',
      cause: expect.objectContaining({ message: 'summary unavailable' }),
    } satisfies Partial<ContextCompactionUnavailableError>);
    expect(messages).toEqual(original);
  });

  test('rejects an irreducibly oversized current request instead of dropping history', async () => {
    await expect(prepare([message('current-user', 'x'.repeat(500_000))])).rejects.toBeInstanceOf(
      ModelInputBudgetExceededError,
    );
  });
});
