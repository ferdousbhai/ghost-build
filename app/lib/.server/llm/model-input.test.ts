import { describe, expect, test, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { MAX_ESTIMATED_MODEL_INPUT_TOKENS } from 'ghostbuild-agent/context-limits';
import { ModelInputBudgetExceededError, modelCompactionPolicy, prepareModelInput } from './model-input';
import type { ContextCompactionUnavailableError } from './model-input';

const tools = [
  { name: 'read', label: 'Read', description: 'Read a file', parameters: { type: 'object' } },
  {
    name: 'write',
    label: 'Write',
    description: 'Write a file with a deliberately longer definition',
    parameters: { type: 'object' },
  },
] as unknown as AgentTool[];

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
    contextWindow: 128_000,
    systemPrompt: '',
    tools,
    ...options,
  });
}

describe('prepareModelInput', () => {
  test('derives compaction boundaries from the model window and output reserve', () => {
    expect(modelCompactionPolicy(128_000)).toEqual({
      proactiveTokens: 79_328,
      hardLimitTokens: 99_328,
    });
    expect(modelCompactionPolicy(256_000).hardLimitTokens).toBe(MAX_ESTIMATED_MODEL_INPUT_TOKENS);
  });

  test('builds small provider inputs once with complete history', async () => {
    const summarize = vi.fn(async () => 'summary');
    const messages = [message('old-user', 'earlier requirement'), message('current-user', 'Build it')];

    const result = await prepare(messages, { summarize, systemPrompt: 'System' });

    expect(result.contextCompacted).toBe(false);
    expect(result.nextCompaction).toBeNull();
    expect(result.promptMessages).toBe(messages);
    expect(result.messages.map((item) => item.role)).toEqual(['user', 'user']);
    expect(JSON.stringify(result.messages)).toContain('earlier requirement');
    expect(JSON.stringify(result.messages)).not.toContain('System');
    expect(summarize).not.toHaveBeenCalled();
  });

  test('compacts once after the actual provider input reaches the model-safe limit', async () => {
    const result = await prepare(largeHistory());

    expect(result.nextCompaction?.summary).toContain('Compacted');
    expect(result.contextCompacted).toBe(true);
    expect(result.promptMessages.length).toBeLessThan(48);
    expect(result.estimatedTokens).toBeLessThanOrEqual(MAX_ESTIMATED_MODEL_INPUT_TOKENS);
  });

  test('compacts a valid transcript larger than four MiB before enforcing the provider limit', async () => {
    const messages = largeHistory(220);
    expect(new TextEncoder().encode(JSON.stringify(messages)).byteLength).toBeGreaterThan(4 * 1024 * 1024);

    const result = await prepare(messages);

    expect(result.contextCompacted).toBe(true);
    expect(result.nextCompaction).not.toBeNull();
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
      ...Array.from({ length: 20 }, (_, index) => message(`new-${index}`, 'y'.repeat(20_000))),
    ];

    const second = await prepare(extended, {
      currentCompaction: first.nextCompaction,
      summarize: async () => 'updated summary',
    });

    expect(second.contextCompacted).toBe(true);
    expect(second.nextCompaction?.summary).toBe('updated summary');
    expect(second.nextCompaction?.fromMessageId).toBe(first.nextCompaction?.fromMessageId);
  });

  test('preserves cancellation instead of reporting compaction failure', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(prepare(largeHistory(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
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
