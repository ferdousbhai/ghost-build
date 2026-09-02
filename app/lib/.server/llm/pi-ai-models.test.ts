import { describe, expect, it, vi } from 'vitest';
import { Type, type Message } from '@earendil-works/pi-ai';
import { DEFAULT_WORKERS_AI_MODEL, type WorkersAiModel } from '~/lib/workers-ai-model';
import { getPiModel, type ModelStreamOptions } from './pi-ai-models';

/** The OpenAI-compatible body and binding options the adapter forwards, as this test reads them. */
type BindingInputs = {
  model?: string;
  messages?: unknown[];
  tools?: unknown[];
  stream?: boolean;
  tool_choice?: unknown;
  max_completion_tokens?: number;
};
type BindingOptions = {
  returnRawResponse?: boolean;
  signal?: AbortSignal;
  extraHeaders?: { 'x-session-affinity'?: string };
  gateway?: { id: string; collectLog: boolean; skipCache: boolean };
};

describe('Pi Workers AI model binding', () => {
  it.each(['@cf/zai-org/glm-5.3-flash', '@cf/openai/gpt-oss-120b'] as const)(
    'routes %s directly through the user-owned AI binding',
    async (modelId) => {
      const { binding, run } = recordingBinding(modelId);
      const selectedModel: WorkersAiModel = {
        ...DEFAULT_WORKERS_AI_MODEL,
        id: modelId,
        label: modelId,
        requiresPaid: modelId === DEFAULT_WORKERS_AI_MODEL.id,
      };
      const handle = getPiModel(binding, modelId, { model: selectedModel, sessionAffinity: 'opaque-session' });
      const messages: Message[] = [{ role: 'user', content: 'Hi', timestamp: 1 }];

      const result = await handle
        .stream(
          handle.model,
          {
            messages,
            tools: [
              {
                name: 'write',
                description: 'Write a project file.',
                parameters: Type.Object({ path: Type.String(), content: Type.String() }),
              },
            ],
          },
          { toolChoice: 'required' } as ModelStreamOptions & { toolChoice: 'required' },
        )
        .result();

      expect(result.content).toContainEqual({ type: 'text', text: 'Hello' });
      expect(run).toHaveBeenCalledWith(
        modelId,
        expect.objectContaining({
          messages: expect.any(Array),
          stream: true,
          tool_choice: 'required',
          tools: expect.any(Array),
        }),
        expect.objectContaining({
          returnRawResponse: true,
          signal: expect.any(AbortSignal),
          extraHeaders: { 'x-session-affinity': 'opaque-session' },
        }),
      );
      if (selectedModel.requiresPaid) {
        expect(run.mock.calls[0]?.[2]).toEqual(
          expect.objectContaining({ gateway: { id: 'default', collectLog: false, skipCache: true } }),
        );
      } else {
        expect(run.mock.calls[0]?.[2]).not.toHaveProperty('gateway');
      }
      expect(handle.model).toMatchObject({
        id: modelId,
        contextWindow: selectedModel.contextTokens,
        maxTokens: selectedModel.contextTokens,
        reasoning: selectedModel.reasoning,
        input: selectedModel.vision ? ['text', 'image'] : ['text'],
      });
    },
  );

  it('asks for every output token the window has left, not a fixed cap', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 1_048_576 };
    const { binding, run } = recordingBinding(model.id);
    const handle = getPiModel(binding, model.id, { model });

    await handle.stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }).result();

    const requested = run.mock.calls[0]?.[1].max_completion_tokens ?? 0;
    // Everything the window physically has left once the estimator's safety margin is removed —
    // far beyond any static ceiling, and always inside the window itself.
    expect(requested).toBeGreaterThan(900_000);
    expect(requested).toBeLessThan(model.contextTokens);
  });

  it('leaves the request room inside the window when the context is already large', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 128_000 };
    const { binding, run } = recordingBinding(model.id);
    const handle = getPiModel(binding, model.id, { model });

    await handle
      .stream(handle.model, {
        systemPrompt: 'You build software.',
        messages: [{ role: 'user', content: 'x'.repeat(160_000), timestamp: 1 }],
      })
      .result();

    const requested = run.mock.calls[0]?.[1].max_completion_tokens ?? 0;
    // The provider rejects input + output beyond the window, so ~40k input tokens has to leave the
    // requested output strictly below the remainder.
    expect(requested).toBeGreaterThan(0);
    expect(requested + 40_000).toBeLessThan(model.contextTokens);
  });

  it('still asks for a real output budget when the window is already full', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 128_000 };
    const { binding, run } = recordingBinding(model.id);
    const handle = getPiModel(binding, model.id, { model });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'x'.repeat(1_000_000), timestamp: 1 }] })
      .result();

    // Omitting the field would hand the request Workers AI's own 256-token default and truncate it
    // silently; asking for the floor makes an impossible request fail loudly instead.
    const inputs = run.mock.calls[0]?.[1];
    expect(inputs).toHaveProperty('max_completion_tokens');
    expect(inputs?.max_completion_tokens).toBe(4_096);
  });

  it('lifts a caller budget below the floor rather than shipping a truncating one', async () => {
    const { binding, run } = recordingBinding(DEFAULT_WORKERS_AI_MODEL.id);
    const handle = getPiModel(binding, DEFAULT_WORKERS_AI_MODEL.id, { model: DEFAULT_WORKERS_AI_MODEL });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { maxTokens: 512 })
      .result();

    expect(run.mock.calls[0]?.[1].max_completion_tokens).toBe(4_096);
  });

  it('keeps a caller-declared output budget for non-builder requests', async () => {
    const { binding, run } = recordingBinding(DEFAULT_WORKERS_AI_MODEL.id);
    const handle = getPiModel(binding, DEFAULT_WORKERS_AI_MODEL.id, { model: DEFAULT_WORKERS_AI_MODEL });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Summarize', timestamp: 1 }] }, { maxTokens: 16_000 })
      .result();

    expect(run.mock.calls[0]?.[1].max_completion_tokens).toBe(16_000);
  });

  it('replays the request at the completion cap the provider names in its rejection', async () => {
    // The catalog window Cloudflare reports for glm-5.3-flash, which the provider does not honour.
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 1_310_720 };
    const { binding, run } = cappingBinding(model.id, OUTPUT_CAP_REJECTION, 1);
    const handle = getPiModel(binding, model.id, { model });

    const result = await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] })
      .result();

    expect(result.content).toContainEqual({ type: 'text', text: 'Hello' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[1].max_completion_tokens ?? 0).toBeGreaterThan(1_048_576);
    expect(run.mock.calls[1]?.[1].max_completion_tokens).toBe(1_048_576);
  });

  it('leaves a rejection that names no completion cap alone', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 1_310_720 };
    const { binding, run } = cappingBinding(model.id, '{"error":"messages: field required"}', 1);
    const handle = getPiModel(binding, model.id, { model });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] })
      .result()
      .catch(() => undefined);

    expect(run).toHaveBeenCalledOnce();
  });

  it('does not replay a request the provider rejects a second time', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 1_310_720 };
    const { binding, run } = cappingBinding(model.id, OUTPUT_CAP_REJECTION, 2);
    const handle = getPiModel(binding, model.id, { model });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] })
      .result()
      .catch(() => undefined);

    expect(run).toHaveBeenCalledTimes(2);
  });
});

/** Verbatim from a production glm-5.3-flash rejection. */
const OUTPUT_CAP_REJECTION =
  'max_completion_tokens is too large: 1200000.This model supports at most 1048576 completion tokens.';

function recordingBinding(modelId: string) {
  const run = vi.fn(async (_model: string, _inputs: BindingInputs, _options: BindingOptions) =>
    completionResponse(modelId),
  );
  return { binding: bindingFor(run), run };
}

/** Answers the first `rejections` requests with the provider's own output-cap 400. */
function cappingBinding(modelId: string, rejectionBody: string, rejections: number) {
  let remaining = rejections;
  const run = vi.fn(async (_model: string, _inputs: BindingInputs, _options: BindingOptions) => {
    if (remaining > 0) {
      remaining -= 1;
      return new Response(rejectionBody, { status: 400 });
    }
    return completionResponse(modelId);
  });
  return { binding: bindingFor(run), run };
}

function bindingFor(run: (model: string, inputs: BindingInputs, options: BindingOptions) => Promise<Response>) {
  // SAFETY: `Ai` declares far more than the raw-run entry point the adapter reaches; this stub
  // implements exactly the `run` overload it calls, which is all the code under test can observe.
  return { binding: { run } as unknown as Ai };
}

function completionResponse(modelId: string): Response {
  return new Response(
    [
      `data: ${JSON.stringify({
        id: 'completion-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: modelId,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: 'completion-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: modelId,
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: 'completion-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
