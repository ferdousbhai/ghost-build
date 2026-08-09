import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiStreamChunk } from './pi-stream';
import { BUILDER_TURN_MAX_MODEL_STEPS } from './builder-turn-budget';

type UIMessageChunk = PiStreamChunk;

type TestStep = { toolResults: Array<{ toolName: string; output: unknown }> };

const mocks = vi.hoisted(() => ({
  completion: undefined as string | undefined,
  steps: [] as TestStep[],
  piRun: vi.fn(),
  getValidatedBuildCompletion: vi.fn(),
  getWorkersAiToolSettings: vi.fn(),
  prepareModelInput: vi.fn(async (options: { messages: unknown[] }) => ({
    messages: [],
    promptMessages: options.messages,
    nextCompaction: null,
    contextCompacted: false,
    estimatedTokens: 1,
  })),
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
  prepareModelInput: mocks.prepareModelInput,
}));
vi.mock('./pi-message-conversion', () => ({
  modelMessagesToPi: vi.fn(() => []),
}));
vi.mock('./pi-tools-adapter', () => ({
  createPiToolBundle: vi.fn(() => ({ canonicalTools: { write: { inputSchema: 'canonical-schema' } }, piTools: {} })),
  piToolsToList: vi.fn(() => [
    { name: 'read', description: 'read' },
    { name: 'write', description: 'write' },
    { name: 'edit', description: 'edit' },
    { name: 'exec', description: 'exec' },
  ]),
}));
vi.mock('./workers-ai-tools', () => ({
  createWorkersAiTools: vi.fn(() => ({})),
  getValidatedBuildCompletion: mocks.getValidatedBuildCompletion,
  getWorkersAiToolSettings: mocks.getWorkersAiToolSettings,
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
    mocks.getWorkersAiToolSettings.mockReturnValue({ activeTools: [], toolChoice: 'none' });
    mocks.getValidatedBuildCompletion.mockImplementation((_messages: unknown, currentStepResults: unknown[] = []) =>
      currentStepResults.length > 0 ? mocks.completion : undefined,
    );
    // Default pi run just succeeds without tool calls
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, _emit: (e: unknown) => Promise<void>) => {
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
    mocks.piRun.mockImplementation(
      async (_ctx: unknown, _cfg: unknown, emit: (e: { type: string }) => Promise<void>) => {
        for (let i = 0; i < BUILDER_TURN_MAX_MODEL_STEPS; i++) {
          await emit({
            type: 'turn_end',
            message: {} as unknown as { role: string },
            toolResults: [],
          } as unknown as never);
        }
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    expect(
      chunks.some(
        (chunk) =>
          'id' in (chunk as Record<string, unknown>) && (chunk as { id: string }).id === 'validated-build-completion',
      ),
    ).toBe(false);
  });

  it('routes the validated model selection to the Pi provider', async () => {
    await collectChunks(await createAgentStream('deepseek/deepseek-v4-pro'));

    expect(mocks.getPiProvider).toHaveBeenCalledWith(
      expect.anything(),
      'deepseek/deepseek-v4-pro',
      expect.objectContaining({ sessionAffinity: expect.any(String) }),
    );
  });

  it('uses canonical tool schemas for prompt accounting', async () => {
    await collectChunks(await createAgentStream());

    expect(mocks.prepareModelInput).toHaveBeenCalledWith(
      expect.objectContaining({ tools: { write: { inputSchema: 'canonical-schema' } } }),
    );
  });

  it('classifies pre-stream preparation failures without exposing their cause', async () => {
    mocks.prepareModelInput.mockRejectedValueOnce(new Error('private prompt details'));

    await expect(createAgentStream()).rejects.toMatchObject({
      name: 'PiAgentPreparationError',
      diagnosticCode: 'pi_prepare:model_input',
    });
  });

  it('preserves validated completion on the final allowed model step', async () => {
    mocks.completion = 'Validated on the final allowed step.';
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (e: unknown) => Promise<void>) => {
      // Emit a tool result that triggers completion
      await emit({
        type: 'tool_execution_end',
        toolCallId: '1',
        toolName: 'write',
        result: { details: { validation: { ok: true } } },
        isError: false,
      } as unknown as never);
      for (let i = 0; i < BUILDER_TURN_MAX_MODEL_STEPS - 1; i++) {
        await emit({ type: 'turn_end', message: {} as unknown as never, toolResults: [] } as unknown as never);
      }
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks.some((c) => c.type === 'text-delta' && (c as { delta: string }).delta.includes('Validated'))).toBe(
      true,
    );
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
  });

  it('translates Pi tool events into chat tool chunks with structured details', async () => {
    const result = { version: 1, ok: true, summary: 'Read package.json', data: { content: '{}' } };
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      await emit({
        type: 'tool_execution_start',
        toolCallId: 'read-1',
        toolName: 'read',
        args: { path: '/home/project/package.json' },
      });
      await emit({
        type: 'tool_execution_end',
        toolCallId: 'read-1',
        toolName: 'read',
        result: { content: [{ type: 'text', text: JSON.stringify(result) }], details: result },
        isError: false,
      });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool-input-start', toolCallId: 'read-1', toolName: 'read' }),
        expect.objectContaining({
          type: 'tool-input-available',
          toolCallId: 'read-1',
          input: { path: '/home/project/package.json' },
        }),
        expect.objectContaining({ type: 'tool-output-available', toolCallId: 'read-1', output: result }),
      ]),
    );
    expect(mocks.getValidatedBuildCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([{ toolName: 'read', result }]),
    );
  });

  it('preserves Pi text part boundaries in the chat stream', async () => {
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      const message = { timestamp: 123 };
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
      });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Building' },
      });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'text_end', contentIndex: 0 },
      });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toEqual(
      expect.arrayContaining([
        { type: 'text-start', id: 'pi-123-0' },
        { type: 'text-delta', id: 'pi-123-0', delta: 'Building' },
        { type: 'text-end', id: 'pi-123-0' },
      ]),
    );
  });

  it('keeps the four primitive Pi tools stable between model turns', async () => {
    mocks.getWorkersAiToolSettings.mockReturnValue({
      activeTools: ['read', 'write', 'edit', 'exec'],
      toolChoice: 'auto',
    });
    let nextToolNames: string[] = [];
    mocks.piRun.mockImplementation(
      async (
        context: { tools: Array<{ name: string }> },
        config: {
          prepareNextTurn?: (args: { context: { tools: Array<{ name: string }> } }) => unknown;
          toolChoice: string;
        },
        emit: (event: unknown) => Promise<void>,
      ) => {
        expect(context.tools.map((tool) => tool.name)).toEqual(['read', 'write', 'edit', 'exec']);
        await emit({
          type: 'tool_execution_end',
          toolCallId: 'write-1',
          toolName: 'write',
          result: { details: { validation: { ok: true } } },
          isError: false,
        });
        await config.prepareNextTurn?.({ context });
        nextToolNames = context.tools.map((tool) => tool.name);
        expect(config.toolChoice).toBe('auto');
      },
    );

    await collectChunks(await createAgentStream());

    expect(nextToolNames).toEqual(['read', 'write', 'edit', 'exec']);
  });

  it('detects validated completion from a primitive mutation result', async () => {
    mocks.getValidatedBuildCompletion.mockImplementation(
      (_messages: unknown, results: Array<{ result?: { validation?: unknown } }> = []) =>
        results.some(({ result }) => result?.validation) ? 'Project validation passed.' : undefined,
    );
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      await emit({
        type: 'tool_execution_end',
        toolCallId: 'write-1',
        toolName: 'write',
        result: { details: { validation: { ok: true } } },
        isError: false,
      });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'validated-build-completion',
      delta: 'Project validation passed.',
    });
  });
});

function createAgentStream(modelId: Parameters<typeof workersAiAgent>[0]['modelId'] = '@cf/zai-org/glm-5.2') {
  return workersAiAgent({
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
