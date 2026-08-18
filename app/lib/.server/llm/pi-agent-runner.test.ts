import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiStreamChunk } from './pi-stream';

type UIMessageChunk = PiStreamChunk;

const mocks = vi.hoisted(() => ({
  completion: undefined as string | undefined,
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
vi.mock('./builder-skills', () => ({
  createBuilderSkillContext: vi.fn(async () => ({
    prompt: 'Bundled guidance.',
    reader: { read: vi.fn(async () => null) },
  })),
}));
vi.mock('./pi-tools-adapter', () => ({
  createPiToolBundle: vi.fn(() => ({
    write: { name: 'write', description: 'write', parameters: 'canonical-schema' },
  })),
  piToolsToList: vi.fn((tools: object) => Object.values(tools)),
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
import { PiSteeringQueue } from './pi-steering';
import { BUILDER_TURN_INACTIVITY_MS, BUILDER_TURN_MAX_MODEL_STEPS } from './builder-turn-budget';

describe('piAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completion = undefined;
    mocks.piMessages = [];
    mocks.getValidatedBuildCompletion.mockImplementation((_messages: unknown, currentStepResults: unknown[] = []) =>
      currentStepResults.length > 0 ? mocks.completion : undefined,
    );
    mocks.piRun.mockResolvedValue(undefined);
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

  it('uses the final Pi tool schemas for prompt accounting', async () => {
    await collectChunks(await createAgentStream());

    expect(mocks.prepareModelInput).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([expect.objectContaining({ name: 'write', parameters: 'canonical-schema' })]),
      }),
    );
  });

  it('classifies pre-stream preparation failures without exposing their cause', async () => {
    mocks.prepareModelInput.mockRejectedValueOnce(new Error('private prompt details'));

    await expect(createAgentStream()).rejects.toMatchObject({
      name: 'PiAgentPreparationError',
      diagnosticCode: 'pi_prepare:model_input',
    });
  });

  it('preserves validated completion from a tool result', async () => {
    mocks.completion = 'Validated.';
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (e: unknown) => Promise<void>) => {
      // Emit a tool result that triggers completion
      await emit({
        type: 'tool_execution_end',
        toolCallId: '1',
        toolName: 'write',
        result: { details: { validation: { ok: true } } },
        isError: false,
      } as unknown as never);
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

  it('exposes Pi one-at-a-time steering without a model timeout', async () => {
    const steering = new PiSteeringQueue();
    mocks.piMessages = [{ role: 'user', content: 'Use blue instead', timestamp: 1 }];
    steering.reserve({ id: 'steer-1', role: 'user', parts: [{ type: 'text', text: 'Use blue instead' }] })?.commit();
    mocks.piRun.mockImplementation(
      async (
        _context: unknown,
        config: { getSteeringMessages: () => Promise<Array<{ role: string; content: string }>>; timeoutMs?: number },
      ) => {
        await expect(config.getSteeringMessages()).resolves.toEqual([
          expect.objectContaining({ role: 'user', content: 'Use blue instead' }),
        ]);
        await expect(config.getSteeringMessages()).resolves.toEqual([]);
        expect(config.timeoutMs).toBeUndefined();
      },
    );

    await collectChunks(await createAgentStream('@cf/zai-org/glm-5.2', {}, steering));
  });

  it('stops before another model turn after a typed tool timeout', async () => {
    const timeoutPayload = JSON.stringify({
      code: 'builder_turn_budget_exhausted',
      error: 'This build reached its safe execution limit before it finished. Send a follow-up to continue.',
      reason: 'tool_timeout',
      retryable: true,
    });
    mocks.piRun.mockImplementation(
      async (
        _context: unknown,
        config: { shouldStopAfterTurn: () => boolean },
        emit: (event: unknown) => Promise<void>,
      ) => {
        await emit({
          type: 'tool_execution_end',
          toolCallId: 'write-timeout',
          toolName: 'write',
          result: { content: [{ type: 'text', text: timeoutPayload }], details: {} },
          isError: true,
        });
        expect(config.shouldStopAfterTurn()).toBe(true);
        await emit({
          type: 'turn_end',
          message: assistantMessage([{ type: 'toolCall', id: 'write-timeout', name: 'write', arguments: {} }]),
          toolResults: [],
        });
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({ type: 'error', errorText: timeoutPayload });
  });

  it('stops before another model turn after an indeterminate tool settlement', async () => {
    const payload = JSON.stringify({
      code: 'workspace_tool_operation_indeterminate',
      error: 'Unable to confirm workspace tool settlement; the workspace operation outcome is indeterminate.',
      retryable: false,
    });
    mocks.piRun.mockImplementation(
      async (
        _context: unknown,
        config: { shouldStopAfterTurn: () => boolean },
        emit: (event: unknown) => Promise<void>,
      ) => {
        await emit({
          type: 'tool_execution_end',
          toolCallId: 'write-indeterminate',
          toolName: 'write',
          result: { content: [{ type: 'text', text: payload }], details: {} },
          isError: true,
        });
        expect(config.shouldStopAfterTurn()).toBe(true);
        await emit({
          type: 'turn_end',
          message: assistantMessage([{ type: 'toolCall', id: 'write-indeterminate', name: 'write', arguments: {} }]),
          toolResults: [],
        });
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({ type: 'error', errorText: payload });
  });

  it.each([
    ['budget result first', ['budget', 'indeterminate']],
    ['indeterminate result first', ['indeterminate', 'budget']],
  ] as const)('prioritizes an indeterminate error in a combined parallel batch with the %s', async (_label, order) => {
    const budgetPayload = JSON.stringify({
      code: 'builder_turn_budget_exhausted',
      error: 'This build reached its safe execution limit before it finished. Send a follow-up to continue.',
      reason: 'tool_timeout',
      retryable: true,
    });
    const indeterminatePayload = JSON.stringify({
      code: 'workspace_tool_operation_indeterminate',
      error: 'Unable to confirm workspace tool settlement; the workspace operation outcome is indeterminate.',
      retryable: false,
    });
    const results = {
      budget: { toolCallId: 'write-timeout', payload: budgetPayload },
      indeterminate: { toolCallId: 'edit-indeterminate', payload: indeterminatePayload },
    } as const;
    mocks.piRun.mockImplementation(
      async (
        _context: unknown,
        config: { shouldStopAfterTurn: () => boolean },
        emit: (event: unknown) => Promise<void>,
      ) => {
        for (const result of order) {
          await emit({
            type: 'tool_execution_end',
            toolCallId: results[result].toolCallId,
            toolName: result === 'budget' ? 'write' : 'edit',
            result: { content: [{ type: 'text', text: results[result].payload }], details: {} },
            isError: true,
          });
        }
        expect(config.shouldStopAfterTurn()).toBe(true);
        await emit({
          type: 'turn_end',
          message: assistantMessage([
            { type: 'toolCall', id: 'write-timeout', name: 'write', arguments: {} },
            { type: 'toolCall', id: 'edit-indeterminate', name: 'edit', arguments: {} },
          ]),
          toolResults: [],
        });
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({ type: 'error', errorText: indeterminatePayload });
    expect(chunks).not.toContainEqual({ type: 'error', errorText: budgetPayload });
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

  it('stops a model that calls tools forever at the model step ceiling', async () => {
    const onSettled = vi.fn();
    mocks.piRun.mockImplementation(
      fakeModelLoop((step, emit) => emitToolRound(step, emit, { isError: false, details: { summary: 'wrote' } })),
    );

    const chunks = await collectChunks(await createAgentStream('@cf/zai-org/glm-5.2', {}, undefined, { onSettled }));

    expect(chunks).toContainEqual({ type: 'error', errorText: budgetErrorText('max_steps') });
    expect(onSettled).toHaveBeenCalledWith({
      terminalReason: 'max_steps',
      stepCount: BUILDER_TURN_MAX_MODEL_STEPS,
      toolCallCount: BUILDER_TURN_MAX_MODEL_STEPS,
      elapsedMs: expect.any(Number),
      lastValidationState: 'unvalidated',
    });
  });

  it('cannot claim success, finish telemetry, or a validated completion once the budget is exhausted', async () => {
    mocks.getValidatedBuildCompletion.mockImplementation(() => undefined);
    mocks.piRun.mockImplementation(
      fakeModelLoop((step, emit) =>
        emitToolRound(step, emit, { isError: true, details: { summary: 'validation failed' } }),
      ),
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({ type: 'error', errorText: budgetErrorText('max_steps') });
    expect(mocks.recordFinish).not.toHaveBeenCalled();
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(false);
  });

  it('keeps a validated completion reached on the final allowed step', async () => {
    const onSettled = vi.fn();
    mocks.getValidatedBuildCompletion.mockImplementation((_messages: unknown, results: unknown[] = []) =>
      results.length >= BUILDER_TURN_MAX_MODEL_STEPS ? 'Project validation passed.' : undefined,
    );
    mocks.piRun.mockImplementation(
      fakeModelLoop((step, emit) => emitToolRound(step, emit, { isError: false, details: { summary: 'wrote' } })),
    );

    const chunks = await collectChunks(await createAgentStream('@cf/zai-org/glm-5.2', {}, undefined, { onSettled }));

    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalReason: 'completed',
        stepCount: BUILDER_TURN_MAX_MODEL_STEPS,
        lastValidationState: 'validated',
      }),
    );
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(mocks.recordFinish).toHaveBeenCalled();
    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'validated-build-completion',
      delta: 'Project validation passed.',
    });
  });

  it('ends a stalled turn on the inactivity budget', async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    mocks.piRun.mockImplementation(
      async (_context: unknown, _config: unknown, emit: (event: unknown) => Promise<void>, signal?: AbortSignal) => {
        await emit({ type: 'turn_start' });
        await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
      },
    );

    try {
      const collected = collectChunks(await createAgentStream('@cf/zai-org/glm-5.2', {}, undefined, { onSettled }));
      await vi.advanceTimersByTimeAsync(BUILDER_TURN_INACTIVITY_MS);
      const chunks = await collected;

      expect(chunks).toContainEqual({ type: 'error', errorText: budgetErrorText('inactivity') });
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ terminalReason: 'inactivity', stepCount: 0 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an owner cancellation as cancellation rather than budget exhaustion', async () => {
    const onSettled = vi.fn();
    const abortSignal = AbortSignal.abort();
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      await emit({
        type: 'turn_end',
        message: assistantMessage([], { stopReason: 'aborted', errorMessage: 'aborted' }),
        toolResults: [],
      });
    });

    const chunks = await collectChunks(
      await createAgentStream('@cf/zai-org/glm-5.2', {}, undefined, { abortSignal, onSettled }),
    );

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ terminalReason: 'cancelled' }));
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
  steering = new PiSteeringQueue(),
  overrides: Partial<Parameters<typeof piAgentRunner>[0]> = {},
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
    steering,
    onSettled: vi.fn(),
    ...overrides,
  });
}

function budgetErrorText(reason: string) {
  return JSON.stringify({
    code: 'builder_turn_budget_exhausted',
    error: 'This build reached its safe execution limit before it finished. Send a follow-up to continue.',
    reason,
    retryable: true,
  });
}

/** Drive the runner's loop config the way pi-agent-core does: turn_end, then the stop check. */
function fakeModelLoop(turn: (step: number, emit: (event: unknown) => Promise<void>) => Promise<void>) {
  return async (
    _context: unknown,
    config: { shouldStopAfterTurn?: (value: unknown) => boolean | Promise<boolean> },
    emit: (event: unknown) => Promise<void>,
  ) => {
    for (let step = 1; step <= BUILDER_TURN_MAX_MODEL_STEPS + 10; step += 1) {
      await turn(step, emit);
      const message = assistantMessage([{ type: 'toolCall', id: `call-${step}`, name: 'write', arguments: {} }]);
      await emit({ type: 'turn_end', message, toolResults: [] });
      if (await config.shouldStopAfterTurn?.({ message, toolResults: [], context: {}, newMessages: [] })) {
        return;
      }
    }
    throw new Error('The runner never stopped the fake model loop.');
  };
}

async function emitToolRound(
  step: number,
  emit: (event: unknown) => Promise<void>,
  result: { isError: boolean; details: unknown },
) {
  await emit({ type: 'tool_execution_start', toolCallId: `call-${step}`, toolName: 'write', args: {} });
  await emit({
    type: 'tool_execution_end',
    toolCallId: `call-${step}`,
    toolName: 'write',
    result: { details: result.details },
    isError: result.isError,
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
