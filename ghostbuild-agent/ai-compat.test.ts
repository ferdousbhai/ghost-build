import { describe, expect, it } from 'vitest';
import { cachedPromptTokens, cachedPromptTokenCount, getToolInvocation, messageText } from './ai-compat.js';

describe('AI compatibility helpers', () => {
  it('handles cyclic provider metadata while finding cached token usage', () => {
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    metadata.cloudflare = { cachedPromptTokens: 42 };

    expect(cachedPromptTokens(metadata)).toBe(42);
    expect(cachedPromptTokenCount(metadata)).toBe(42);
    expect(cachedPromptTokenCount({ cloudflare: { prompt_tokens_details: { cached_tokens: 0 } } })).toBe(0);
    expect(cachedPromptTokenCount({ inputTokenDetails: { cacheReadTokens: 17 } })).toBe(17);
    expect(cachedPromptTokenCount({ cloudflare: {} })).toBeUndefined();
    expect(cachedPromptTokenCount({ first: { cacheRead: 0 }, second: { cacheRead: 7 } })).toBe(7);
    expect(cachedPromptTokenCount({ cacheRead: -1 })).toBeUndefined();
  });

  it('reads message text exclusively from native parts', () => {
    expect(messageText({ parts: [{ type: 'text', text: 'hello' }] })).toBe('hello');
  });

  it('preserves native error and denial tool states', () => {
    expect(
      getToolInvocation({
        type: 'tool-read',
        toolCallId: 'read-1',
        state: 'output-error',
        input: { path: '/home/project/missing.ts' },
        errorText: 'File not found',
      }),
    ).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'read',
      state: 'output-error',
      errorText: 'File not found',
    });
    expect(
      getToolInvocation({
        type: 'dynamic-tool',
        toolName: 'exec',
        toolCallId: 'exec-1',
        state: 'output-denied',
        input: { command: 'dangerous' },
        approval: { id: 'approval-1', approved: false, reason: 'Not approved' },
      }),
    ).toMatchObject({
      state: 'output-denied',
      approval: { approved: false, reason: 'Not approved' },
    });
  });
});
