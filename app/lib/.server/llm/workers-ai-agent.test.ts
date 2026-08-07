import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiStreamChunk } from './pi-stream';
import { BUILDER_TURN_MAX_MODEL_STEPS, BUILDER_TURN_TIMEOUTS } from './builder-turn-budget';

type UIMessageChunk = PiStreamChunk;

type TestStep = { toolResults: Array<{ toolName: string; output: unknown }> };

const mocks = vi.hoisted(() => ({
  completion: undefined as string | undefined,
  steps: [] as TestStep[],
  piRun: vi.fn(),
  getValidatedBuildCompletion: vi.fn(),
  getPiProvider: vi.fn(() => ({ handle: { model: { id: 'test-workers-ai' }, stream: vi.fn() }, maxTokens: 1_000 })),
}));

vi.mock('@earendil-works/pi-agent-core', () => ({
  runAgentLoopContinue: mocks.piRun,
}));
vi.mock('./provider', () => ({
  getPiProvider: mocks.getPiProvider,
  getProvider: vi.fn(() => ({ model: { modelId: 'test-workers-ai' }, maxTokens: 1_000 })),
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
vi.mock('./pi-message-conversion', () => ({
  modelMessagesToPi: vi.fn(() => []),
}));
vi.mock('./pi-tools-adapter', () => ({
  createPiTools: vi.fn(() => ({})),
  piToolsToList: vi.fn(() => []),
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

describe('workersAiAgent turn budgets (Pi)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completion = undefined;
    mocks.steps = [];
    mocks.getValidatedBuildCompletion.mockImplementation((_messages: unknown, currentStepResults: unknown[] = []) =>
      currentStepResults.length > 0 ? mocks.completion : undefined,
    );
    // Default pi run just succeeds without tool calls
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (e: unknown) => Promise<void>) => {
      // Simulate budget check: if steps exceed, still emit nothing — piAgentRunner handles budget
      if (mocks.steps.length >= BUILDER_TURN_MAX_MODEL_STEPS) {
        // budget will be detected in piAgentRunner final check
      }
    });
  });

  it('emits a typed error and no deterministic completion when the model-step budget is exhausted', async () => {
    mocks.steps = Array.from({ length: BUILDER_TURN_MAX_MODEL_STEPS }, () => ({ toolResults: [] }));
    // Simulate pi loop that would exceed steps: piAgentRunner tracks stepCount via turn_end events.
    // For this test, make piRun emit turn_end events that drive stepCount to max
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (e: { type: string }) => Promise<void>) => {
      for (let i = 0; i < BUILDER_TURN_MAX_MODEL_STEPS; i++) {
        await emit({ type: 'turn_end', message: {} as unknown as { role: string }, toolResults: [] } as unknown as never);
      }
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    expect(chunks.some((chunk) => 'id' in (chunk as Record<string, unknown>) && (chunk as { id: string }).id === 'validated-build-completion')).toBe(false);
  });

  it('routes the validated model selection to the Pi provider', async () => {
    await collectChunks(await createAgentStream('deepseek/deepseek-v4-pro'));

    expect(mocks.getPiProvider).toHaveBeenCalledWith(
      expect.anything(),
      'deepseek/deepseek-v4-pro',
      expect.objectContaining({ sessionAffinity: expect.any(String) }),
    );
  });

  it('preserves validated completion on the final allowed model step', async () => {
    mocks.completion = 'Validated on the final allowed step.';
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (e: unknown) => Promise<void>) => {
      // Emit a tool result that triggers completion
      await emit({ type: 'tool_execution_end', toolCallId: '1', toolName: 'validateProject', result: {}, isError: false } as unknown as never);
      for (let i = 0; i < BUILDER_TURN_MAX_MODEL_STEPS - 1; i++) {
        await emit({ type: 'turn_end', message: {} as unknown as never, toolResults: [] } as unknown as never);
      }
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks.some((c) => c.type === 'text-delta' && (c as { delta: string }).delta.includes('Validated'))).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
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
