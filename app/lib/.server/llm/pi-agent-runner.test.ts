import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiStreamChunk } from './pi-stream';
import { BUILDER_TURN_MAX_MODEL_STEPS } from './builder-turn-budget';

type UIMessageChunk = PiStreamChunk;

type TestStep = { toolResults: Array<{ toolName: string; output: unknown }> };

const mocks = vi.hoisted(() => ({
  completion: undefined as string | undefined,
  steps: [] as TestStep[],
  piMessages: [] as unknown[],
  piRun: vi.fn(),
  getValidatedBuildCompletion: vi.fn(),
  prepareModelInput: vi.fn(async (options: { messages: unknown[] }) => ({
    messages: [],
    promptMessages: options.messages,
    nextCompaction: null,
    contextCompacted: false,
    estimatedTokens: 1,
  })),
  getPiProvider: vi.fn(() => ({
    handle: { model: { id: 'test-workers-ai', contextWindow: 128_000 }, stream: vi.fn() },
    maxTokens: 1_000,
  })),
  recordFinish: vi.fn(),
}));

vi.mock('@earendil-works/pi-agent-core', () => ({
  runAgentLoopContinue: mocks.piRun,
}));
vi.mock('./provider', () => ({
  getPiProvider: mocks.getPiProvider,
}));

vi.mock('./model-input', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareModelInput: mocks.prepareModelInput,
}));
vi.mock('./pi-message-conversion', () => ({
  modelMessagesToPi: vi.fn(() => mocks.piMessages),
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
}));
vi.mock('./workers-ai-telemetry', () => ({
  recordFirstWorkersAiResponse: vi.fn(),
  recordWorkersAiFinish: mocks.recordFinish,
}));
import { piAgentRunner } from './pi-agent-runner';

describe('piAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completion = undefined;
    mocks.steps = [];
    mocks.piMessages = [];
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
            message: {
              role: 'assistant',
              content: [{ type: 'toolCall', id: `call-${i}`, name: 'read', arguments: { path: 'x' } }],
              usage: piUsage(),
              stopReason: 'toolUse',
            },
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

  it('records native Pi usage without turning successful completion into an error', async () => {
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      await emit({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
          usage: piUsage({ input: 40, output: 5, totalTokens: 45 }),
          stopReason: 'stop',
        },
        toolResults: [],
      });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(mocks.recordFinish).toHaveBeenCalledWith(
      expect.objectContaining({ usage: expect.objectContaining({ input: 40, output: 5, totalTokens: 45 }) }),
    );
  });

  it('surfaces provider protocol failures instead of finishing an empty successful turn', async () => {
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      await emit({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [],
          usage: piUsage(),
          stopReason: 'error',
          errorMessage: 'upstream failed',
        },
        toolResults: [],
      });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({ type: 'error', errorText: 'The model request failed. Please retry.' });
    expect(mocks.recordFinish).not.toHaveBeenCalled();
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

  it('streams Pi tool arguments and transient execution progress before the final result', async () => {
    const call = { type: 'toolCall', id: 'exec-1', name: 'exec', arguments: {} };
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      const message = { timestamp: 123 };
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: { content: [call] } },
      });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"command":"pnpm test"}' },
      });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { ...call, arguments: { command: 'pnpm test' } },
        },
      });
      await emit({
        type: 'tool_execution_start',
        toolCallId: 'exec-1',
        toolName: 'exec',
        args: { command: 'pnpm test' },
      });
      await emit({
        type: 'tool_execution_update',
        toolCallId: 'exec-1',
        toolName: 'exec',
        args: { command: 'pnpm test' },
        partialResult: { details: { stdout: 'building\n' } },
      });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks.filter((chunk) => chunk.type === 'tool-input-start')).toHaveLength(1);
    expect(chunks).toEqual(
      expect.arrayContaining([
        { type: 'tool-input-delta', toolCallId: 'exec-1', inputTextDelta: '{"command":"pnpm test"}' },
        expect.objectContaining({
          type: 'tool-input-available',
          toolCallId: 'exec-1',
          input: { command: 'pnpm test' },
        }),
        expect.objectContaining({
          type: 'data-tool-progress',
          id: 'exec-1',
          transient: true,
        }),
      ]),
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

  it('exposes exactly the four primitive Pi tools with automatic selection', async () => {
    mocks.piRun.mockImplementation(
      async (context: { tools: Array<{ name: string }> }, config: { toolChoice: string }) => {
        expect(context.tools.map((tool) => tool.name)).toEqual(['read', 'write', 'edit', 'exec']);
        expect(config.toolChoice).toBe('auto');
      },
    );

    await collectChunks(await createAgentStream());
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

  it('stops the model loop as soon as the exact revision is validated', async () => {
    mocks.completion = 'Project validation passed.';
    mocks.piRun.mockImplementation(
      async (
        _context: unknown,
        config: { shouldStopAfterTurn: (value: { message: ReturnType<typeof assistantMessage> }) => boolean },
        emit: (event: unknown) => Promise<void>,
      ) => {
        await emit({
          type: 'tool_execution_end',
          toolCallId: 'validate-1',
          toolName: 'exec',
          result: { details: { validation: { ok: true } } },
          isError: false,
        });
        expect(
          config.shouldStopAfterTurn({
            message: assistantMessage([{ type: 'toolCall', id: 'validate-1', name: 'exec', arguments: {} }]),
          }),
        ).toBe(true);
        await emit({
          type: 'turn_end',
          message: assistantMessage([{ type: 'toolCall', id: 'validate-1', name: 'exec', arguments: {} }]),
          toolResults: [],
        });
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'validated-build-completion',
      delta: 'Project validation passed.',
    });
  });

  it('compacts live tool-loop context before another model step', async () => {
    const summarize = vi.fn(async () => '## Goal\nFinish the build.');
    const requestDurableCompaction = vi.fn();
    mocks.piMessages = runtimeHistory();
    mocks.piRun.mockImplementation(
      async (
        context: { messages: unknown[] },
        config: { prepareNextTurn?: (value: unknown) => Promise<{ context?: { messages: unknown[] } } | undefined> },
        emit: (event: unknown) => Promise<void>,
      ) => {
        const toolMessage = assistantMessage([{ type: 'toolCall', id: 'read-1', name: 'read', arguments: {} }]);
        const next = await config.prepareNextTurn?.({
          message: toolMessage,
          context,
          newMessages: [],
          toolResults: [],
        });
        expect(next?.context?.messages[0]).toMatchObject({ role: 'user' });
        expect(JSON.stringify(next?.context?.messages[0])).toContain('<summary>');
        await emit({ type: 'turn_end', message: assistantMessage([{ type: 'text', text: 'Done' }]), toolResults: [] });
      },
    );

    const chunks = await collectChunks(
      await createAgentStream('@cf/zai-org/glm-5.2', { summarize, requestDurableCompaction }),
    );

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(summarize).toHaveBeenCalled();
    expect(requestDurableCompaction).toHaveBeenCalled();
  });

  it('compacts and retries one invisible context-overflow response', async () => {
    const summarize = vi.fn(async () => '## Goal\nRecover the build.');
    const requestDurableCompaction = vi.fn();
    mocks.piMessages = runtimeHistory();
    mocks.piRun
      .mockImplementationOnce(
        async (context: { messages: unknown[] }, _config: unknown, emit: (event: unknown) => Promise<void>) => {
          const overflow = assistantMessage([], {
            stopReason: 'error',
            errorMessage: 'The prompt exceeds the context window.',
          });
          context.messages.push(overflow);
          await emit({ type: 'turn_end', message: overflow, toolResults: [] });
        },
      )
      .mockImplementationOnce(
        async (context: { messages: unknown[] }, _config: unknown, emit: (event: unknown) => Promise<void>) => {
          expect(JSON.stringify(context.messages[0])).toContain('<summary>');
          await emit({
            type: 'turn_end',
            message: assistantMessage([{ type: 'text', text: 'Recovered' }]),
            toolResults: [],
          });
        },
      );

    const chunks = await collectChunks(
      await createAgentStream('@cf/zai-org/glm-5.2', { summarize, requestDurableCompaction }),
    );

    expect(mocks.piRun).toHaveBeenCalledTimes(2);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(requestDurableCompaction).toHaveBeenCalled();
  });

  it('does not retry a second invisible overflow', async () => {
    mocks.piMessages = runtimeHistory();
    const overflowRun = async (
      context: { messages: unknown[] },
      _config: unknown,
      emit: (event: unknown) => Promise<void>,
    ) => {
      const overflow = assistantMessage([], {
        stopReason: 'error',
        errorMessage: 'The prompt exceeds the context window.',
      });
      context.messages.push(overflow);
      await emit({ type: 'turn_end', message: overflow, toolResults: [] });
    };
    mocks.piRun.mockImplementation(overflowRun);

    const chunks = await collectChunks(
      await createAgentStream('@cf/zai-org/glm-5.2', { summarize: async () => 'Checkpoint' }),
    );

    expect(mocks.piRun).toHaveBeenCalledTimes(2);
    expect(chunks).toContainEqual({ type: 'error', errorText: 'The model request failed. Please retry.' });
  });

  it('does not retry an overflow after model content was streamed', async () => {
    mocks.piMessages = runtimeHistory();
    mocks.piRun.mockImplementation(
      async (context: { messages: unknown[] }, _config: unknown, emit: (event: unknown) => Promise<void>) => {
        await emit({
          type: 'message_update',
          message: { timestamp: 123 },
          assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
        });
        const overflow = assistantMessage([], {
          stopReason: 'error',
          errorMessage: 'The prompt exceeds the context window.',
        });
        context.messages.push(overflow);
        await emit({ type: 'turn_end', message: overflow, toolResults: [] });
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(mocks.piRun).toHaveBeenCalledOnce();
    expect(chunks).toContainEqual({ type: 'error', errorText: 'The model request failed. Please retry.' });
  });
});

function createAgentStream(
  modelId: Parameters<typeof piAgentRunner>[0]['modelId'] = '@cf/zai-org/glm-5.2',
  compactionOverrides: Partial<Parameters<typeof piAgentRunner>[0]['compaction']> = {},
) {
  return piAgentRunner({
    firstUserMessage: false,
    messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Build it' }] }],
    modelId,
    compaction: {
      current: null,
      pending: false,
      summarize: async () => 'summary',
      save: vi.fn(),
      ...compactionOverrides,
    },
    accountCredentials: { binding: {} as Ai },
    sessionAffinity: 'opaque-session',
    workspace: {} as never,
    runWithKeepAlive: (operation) => operation(),
  });
}

function runtimeHistory() {
  return Array.from({ length: 6 }, (_, index) => ({
    role: 'user',
    content: `${index}:${'x'.repeat(70_000)}`,
    timestamp: index,
  }));
}

function assistantMessage(content: unknown[], overrides: { stopReason?: string; errorMessage?: string } = {}) {
  return {
    role: 'assistant',
    content,
    timestamp: Date.now(),
    api: 'openai-completions',
    provider: 'cloudflare-workers-ai',
    model: 'test-workers-ai',
    usage: piUsage(),
    stopReason: overrides.stopReason ?? 'stop',
    ...(overrides.errorMessage ? { errorMessage: overrides.errorMessage } : {}),
  };
}

function piUsage(overrides: Partial<{ input: number; output: number; totalTokens: number }> = {}) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

async function collectChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
