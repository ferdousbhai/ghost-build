import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { GhostbuildToolSet } from 'ghostbuild-agent/types';
import { ModelInputBudgetExceededError, prepareBoundedModelInput } from './model-input-budget';

const tools = {
  view: { description: 'Read a file', inputSchema: z.object({ path: z.string() }) },
} as unknown as GhostbuildToolSet;

function message(id: string, role: 'user' | 'assistant', text: string): GhostbuildMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

describe('prepareBoundedModelInput', () => {
  test('keeps a small model input unchanged', async () => {
    const result = await prepareBoundedModelInput({
      uiMessages: [message('user-1', 'user', 'Build it')],
      systemPrompts: ['System'],
      tools,
      toolChoice: 'auto',
      maximumEstimatedTokens: 1_000,
    });

    expect(result.reduced).toBe(false);
    expect(result.droppedMessageCount).toBe(0);
    expect(result.messages.map((item) => item.role)).toEqual(['system', 'user']);
  });

  test('drops only older history and preserves the complete current-turn suffix', async () => {
    const uiMessages = [
      message('old-user', 'user', 'x'.repeat(2_000)),
      message('old-assistant', 'assistant', 'y'.repeat(2_000)),
      message('current-user', 'user', 'keep-current-user'),
      message('current-assistant', 'assistant', 'keep-current-tool-follow-up'),
    ];

    const result = await prepareBoundedModelInput({
      uiMessages,
      systemPrompts: [],
      tools,
      toolChoice: 'auto',
      maximumEstimatedTokens: 250,
    });
    const serialized = JSON.stringify(result.messages);

    expect(result.reduced).toBe(true);
    expect(serialized).not.toContain('old-user');
    expect(serialized).toContain('keep-current-user');
    expect(serialized).toContain('keep-current-tool-follow-up');
  });

  test('fails closed when fixed context and the current turn cannot fit', async () => {
    await expect(
      prepareBoundedModelInput({
        uiMessages: [message('current-user', 'user', 'x'.repeat(4_000))],
        systemPrompts: ['System'],
        tools,
        toolChoice: 'none',
        maximumEstimatedTokens: 100,
      }),
    ).rejects.toBeInstanceOf(ModelInputBudgetExceededError);
  });
});
