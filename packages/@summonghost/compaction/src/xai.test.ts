import { describe, expect, it, vi } from 'vitest';
import {
  buildXaiCompactionInput,
  createXaiCompactionAdapter,
  parseXaiNativeUsage,
  readXaiCompletedResponseOutput,
  readXaiResponseInput,
} from './index.js';

describe('xAI compaction adapter', () => {
  it('counts serialized native input through an injected transport', async () => {
    const request = vi.fn(async () =>
      Response.json({
        token_ids: [{ token_id: 1 }, { token_id: 2 }, { token_id: 3 }],
      }),
    );
    const adapter = createXaiCompactionAdapter({ request });

    await expect(
      adapter.countInputTokens({
        items: [{ role: 'user', content: 'hello' }],
        model: 'grok-4.5',
      }),
    ).resolves.toBe(3);
    expect(request).toHaveBeenCalledWith({
      body: {
        model: 'grok-4.5',
        text: JSON.stringify([{ role: 'user', content: 'hello' }]),
      },
      path: '/tokenize-text',
      signal: expect.any(AbortSignal),
    });
  });

  it('compacts through an injected transport and preserves opaque items', async () => {
    const request = vi.fn(async () =>
      Response.json({
        output: [
          {
            type: 'compaction',
            id: 'cmp-1',
            encrypted_content: 'opaque-context',
          },
        ],
        usage: {
          input_tokens: 100_000,
          input_tokens_details: { cached_tokens: 40_000 },
          output_tokens: 2_000,
          total_tokens: 102_000,
          cost_in_usd_ticks: 2_000_000,
          dropped_message_count: 42,
        },
      }),
    );
    const adapter = createXaiCompactionAdapter({ request });

    await expect(
      adapter.compactInput({
        conversationId: 'conversation-1',
        items: [{ role: 'user', content: 'hello' }],
        model: 'grok-4.5',
      }),
    ).resolves.toEqual({
      items: [
        {
          type: 'compaction',
          id: 'cmp-1',
          encrypted_content: 'opaque-context',
        },
      ],
      usage: {
        cacheReadInputTokens: 40_000,
        costUsdTicks: 2_000_000,
        droppedMessageCount: 42,
        inputTokens: 100_000,
        outputTokens: 2_000,
        serverSideToolCalls: 0,
        totalTokens: 102_000,
      },
    });
    expect(request).toHaveBeenCalledWith({
      body: {
        model: 'grok-4.5',
        input: [{ role: 'user', content: 'hello' }],
      },
      conversationId: 'conversation-1',
      path: '/responses/compact',
      signal: expect.any(AbortSignal),
    });
  });

  it('uses a byte upper bound, precise counting, and a fail-closed fallback', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          token_ids: Array.from({ length: 20 }, (_, token_id) => ({
            token_id,
          })),
        }),
      )
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const adapter = createXaiCompactionAdapter({ request });

    await expect(
      adapter.shouldCompactInput({
        hardLimitTokens: 1_000,
        items: [{ role: 'user', content: 'short' }],
        knownTokens: 100,
        model: 'grok-4.5',
      }),
    ).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();

    const largeItems = [{ role: 'user', content: 'x'.repeat(1_000) }];
    await expect(
      adapter.shouldCompactInput({
        hardLimitTokens: 1_000,
        items: largeItems,
        knownTokens: 990,
        model: 'grok-4.5',
      }),
    ).resolves.toBe(true);
    await expect(
      adapter.shouldCompactInput({
        hardLimitTokens: 1_000,
        items: largeItems,
        knownTokens: 1,
        model: 'grok-4.5',
      }),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid compaction responses and bounded provider errors', async () => {
    const invalid = createXaiCompactionAdapter({
      request: async () => Response.json({ output: [{ type: 'message' }] }),
    });
    await expect(
      invalid.compactInput({
        items: [{ role: 'user', content: 'hello' }],
        model: 'grok-4.5',
      }),
    ).rejects.toThrow('returned no valid compaction item');

    const failed = createXaiCompactionAdapter({
      request: async () => new Response('provider detail', { status: 429 }),
    });
    await expect(
      failed.compactInput({
        items: [{ role: 'user', content: 'hello' }],
        model: 'grok-4.5',
      }),
    ).rejects.toThrow('xAI context compaction failed (429): provider detail');

    const invalidUsage = createXaiCompactionAdapter({
      request: async () =>
        Response.json({
          output: [
            {
              type: 'compaction',
              id: 'cmp-1',
              encrypted_content: 'opaque-context',
            },
          ],
          usage: { input_tokens: 'unknown', output_tokens: 10 },
        }),
    });
    await expect(
      invalidUsage.compactInput({
        items: [{ role: 'user', content: 'hello' }],
        model: 'grok-4.5',
      }),
    ).rejects.toThrow('returned invalid usage');
  });

  it('times out even when the injected transport ignores its abort signal', async () => {
    const adapter = createXaiCompactionAdapter({
      timeoutMs: 1,
      request: () => new Promise<Response>(() => undefined),
    });

    await expect(
      adapter.countInputTokens({
        items: [{ role: 'user', content: 'hello' }],
        model: 'grok-4.5',
      }),
    ).rejects.toThrow('xAI context token counting timed out');
  });

  it('rejects unsafe token estimates instead of coercing them to zero', async () => {
    const adapter = createXaiCompactionAdapter({
      request: async () => Response.json({ token_ids: [] }),
    });

    await expect(
      adapter.shouldCompactInput({
        hardLimitTokens: 1_000,
        items: [],
        knownTokens: Number.POSITIVE_INFINITY,
        model: 'grok-4.5',
      }),
    ).rejects.toThrow('knownTokens must be a non-negative safe integer');
  });
});

describe('xAI native response helpers', () => {
  it('captures terminal output and excludes system input from compaction', () => {
    const input = [
      { role: 'system', content: 'current instructions' },
      { role: 'user', content: 'hello' },
    ];
    const output = [
      {
        type: 'reasoning',
        id: 'reasoning-1',
        encrypted_content: 'opaque-reasoning',
      },
    ];
    expect(readXaiResponseInput({ input })).toEqual(input);
    expect(
      readXaiCompletedResponseOutput(
        JSON.stringify({
          type: 'response.incomplete',
          response: { output },
        }),
      ),
    ).toEqual(output);
    expect(buildXaiCompactionInput({ input, output })).toEqual([input[1], output[0]]);
  });

  it('normalizes native usage without floating-point cost conversion', () => {
    expect(
      parseXaiNativeUsage({
        input_tokens: 1_000,
        input_tokens_details: { cached_tokens: 600 },
        output_tokens: 50,
        total_tokens: 1_050,
        num_server_side_tools_used: 2,
        cost_in_usd_ticks: 52_345_678,
      }),
    ).toEqual({
      cacheReadInputTokens: 600,
      costUsdTicks: 52_345_678,
      inputTokens: 1_000,
      outputTokens: 50,
      serverSideToolCalls: 2,
      totalTokens: 1_050,
    });
  });

  it('rejects malformed optional native usage instead of coercing it', () => {
    const usage = {
      input_tokens: 1_000,
      output_tokens: 50,
      total_tokens: 1_050,
    };

    expect(
      parseXaiNativeUsage({
        ...usage,
        input_tokens_details: { cached_tokens: 'unknown' },
      }),
    ).toBeNull();
    expect(
      parseXaiNativeUsage({
        ...usage,
        num_server_side_tools_used: -1,
      }),
    ).toBeNull();
    expect(parseXaiNativeUsage({ ...usage, cost_in_usd_ticks: 1.5 })).toBeNull();
    expect(parseXaiNativeUsage(usage)).toMatchObject({
      cacheReadInputTokens: 0,
      costUsdTicks: null,
      serverSideToolCalls: 0,
    });
  });
});
