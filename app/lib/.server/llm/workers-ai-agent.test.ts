import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { BUILDER_TURN_MAX_MODEL_STEPS, BUILDER_TURN_TIMEOUTS } from './builder-turn-budget';

type TestStep = { toolResults: Array<{ toolName: string; output: unknown }> };

const mocks = vi.hoisted(() => ({
  completion: undefined as string | undefined,
  streamFailure: undefined as unknown,
  steps: [] as TestStep[],
  streamText: vi.fn(),
  getValidatedBuildCompletion: vi.fn(),
  getProvider: vi.fn(() => ({ model: { modelId: 'test-workers-ai' }, maxTokens: 1_000 })),
}));

vi.mock('ai', () => ({
  createUIMessageStream: vi.fn(),
  streamText: mocks.streamText,
  toUIMessageStream: vi.fn(
    (options: { onError: (error: unknown) => string }) =>
      new ReadableStream<UIMessageChunk>({
        start(controller) {
          try {
            const streamOptions = mocks.streamText.mock.calls.at(-1)?.[0] as {
              stopWhen: (options: { steps: TestStep[] }) => boolean;
            };
            streamOptions.stopWhen({ steps: mocks.steps });
            if (mocks.streamFailure) {
              throw mocks.streamFailure;
            }
            controller.enqueue({ type: 'finish', finishReason: 'stop' });
          } catch (error) {
            controller.enqueue({ type: 'error', errorText: options.onError(error) });
          }
          controller.close();
        },
      }),
  ),
}));

vi.mock('./provider', () => ({
  getProvider: mocks.getProvider,
}));
vi.mock('./message-conversion', () => ({
  asAiSdkTools: (tools: unknown) => tools,
  asOriginalMessages: (messages: unknown) => messages,
}));
vi.mock('./model-input', () => ({
  prepareModelInput: vi.fn(async (options: { messages: unknown[] }) => ({
    messages: [],
    promptMessages: options.messages,
    nextCompaction: null,
    contextCompacted: false,
    estimatedTokens: 1,
  })),
}));
vi.mock('./workers-ai-tools', () => ({
  createWorkersAiTools: vi.fn(() => ({})),
  getValidatedBuildCompletion: mocks.getValidatedBuildCompletion,
  getWorkersAiToolSettings: vi.fn(() => ({ activeTools: [], toolChoice: 'none' })),
}));
vi.mock('./workers-ai-telemetry', () => ({
  recordFirstWorkersAiResponse: vi.fn(),
  recordWorkersAiFinish: vi.fn(),
}));
import { workersAiAgent } from './workers-ai-agent';

describe('workersAiAgent turn budgets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completion = undefined;
    mocks.streamFailure = undefined;
    mocks.steps = [];
    mocks.getValidatedBuildCompletion.mockImplementation((_messages: unknown, currentStepResults: unknown[] = []) =>
      currentStepResults.length > 0 ? mocks.completion : undefined,
    );
    mocks.streamText.mockReturnValue({ stream: new ReadableStream() });
  });

  it('emits a typed error and no deterministic completion when the model-step budget is exhausted', async () => {
    mocks.steps = Array.from({ length: BUILDER_TURN_MAX_MODEL_STEPS }, () => ({ toolResults: [] }));

    const chunks = await collectChunks(await createAgentStream());

    expect(mocks.streamText).toHaveBeenCalledWith(expect.objectContaining({ timeout: BUILDER_TURN_TIMEOUTS }));
    expect(chunks).toContainEqual({
      type: 'error',
      errorText: JSON.stringify({
        code: 'builder_turn_budget_exhausted',
        error: 'This build reached its safe execution limit before it finished. Send a follow-up to continue.',
        reason: 'model_steps',
        retryable: true,
      }),
    });
    expect(chunks.some((chunk) => 'id' in chunk && chunk.id === 'validated-build-completion')).toBe(false);
  });

  it('routes the validated model selection to the provider', async () => {
    await collectChunks(await createAgentStream('deepseek/deepseek-v4-pro'));

    expect(mocks.getProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'deepseek/deepseek-v4-pro',
      expect.objectContaining({ feature: 'builder-chat' }),
    );
  });

  it('preserves validated completion on the final allowed model step', async () => {
    mocks.completion = 'Validated on the final allowed step.';
    mocks.steps = Array.from({ length: BUILDER_TURN_MAX_MODEL_STEPS }, (_, index) => ({
      toolResults: index === BUILDER_TURN_MAX_MODEL_STEPS - 1 ? [{ toolName: 'validateProject', output: {} }] : [],
    }));

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'validated-build-completion',
      delta: 'Validated on the final allowed step.',
    });
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
  });

  it('emits a typed timeout error without appending completion', async () => {
    mocks.streamFailure = new DOMException('The total request timeout expired.', 'TimeoutError');

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({
      type: 'error',
      errorText: JSON.stringify({
        code: 'builder_turn_budget_exhausted',
        error: 'This build reached its safe execution limit before it finished. Send a follow-up to continue.',
        reason: 'total_timeout',
        retryable: true,
      }),
    });
    expect(chunks.some((chunk) => 'id' in chunk && chunk.id === 'validated-build-completion')).toBe(false);
  });
});

function createAgentStream(modelId: Parameters<typeof workersAiAgent>[0]['modelId'] = '@cf/zai-org/glm-5.2') {
  return workersAiAgent({
    env: {} as Env,
    chatInitialId: 'chat-1',
    firstUserMessage: false,
    messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Build it' }] }],
    modelId,
    compaction: {
      current: null,
      pending: false,
      summarize: async () => 'summary',
      save: vi.fn(),
    },
    accountCredentials: { accountId: 'account-1', apiKey: 'secret' },
    sessionAffinity: 'opaque-session',
    workspace: {} as never,
    userId: 'user-1',
    agentName: 'agent-1',
    runWithKeepAlive: (operation) => operation(),
  });
}

async function collectChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
