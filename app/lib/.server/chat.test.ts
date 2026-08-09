import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
const piAgentRunner = vi.hoisted(() => vi.fn());

vi.mock('ghostbuild-agent/utils/logger', () => ({ createScopedLogger: () => logger }));
vi.mock('~/lib/.server/llm/pi-agent-runner', () => ({ piAgentRunner }));

import { createChatResponseFromBody } from './chat';
import { ContextCompactionUnavailableError, ModelInputBudgetExceededError } from './llm/model-input';

describe('chat provider error boundary', () => {
  beforeEach(() => {
    logger.error.mockReset();
    logger.info.mockReset();
    piAgentRunner.mockReset();
  });

  it('does not log provider errors or request bodies', async () => {
    piAgentRunner.mockRejectedValueOnce(
      Object.assign(new Error('provider included private request values'), {
        requestBodyValues: { prompt: 'SECRET_PROVIDER_PROMPT' },
      }),
    );

    await expect(
      createChatResponseFromBody({
        body: { messages: [], modelId: '@cf/zai-org/glm-5.2' },
        compaction: {
          current: null,
          pending: false,
          summarize: vi.fn(),
          save: vi.fn(),
        },
        firstUserMessage: true,
        accountCredentials: { binding: {} as Ai },
        sessionAffinity: 'session',
        workspace: {} as never,
        runWithKeepAlive: (operation) => operation(),
      }),
    ).rejects.toMatchObject({ status: 500 });

    expect(logger.error).toHaveBeenCalledWith('Workers AI chat request failed', { kind: 'Error' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SECRET_PROVIDER_PROMPT');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private request values');
  });

  it.each([
    [new ModelInputBudgetExceededError(10, 5), 413],
    [new ContextCompactionUnavailableError(new Error('summary failed')), 503],
  ])('preserves actionable model-input failures with status %i', async (error, status) => {
    piAgentRunner.mockRejectedValueOnce(error);

    await expect(createResponse()).rejects.toMatchObject({ status });
  });

  it('forwards the selected allowlisted model to the builder agent', async () => {
    piAgentRunner.mockResolvedValueOnce(new ReadableStream());

    await createChatResponseFromBody({
      body: { messages: [], modelId: 'deepseek/deepseek-v4-pro' },
      compaction: {
        current: null,
        pending: false,
        summarize: vi.fn(),
        save: vi.fn(),
      },
      firstUserMessage: true,
      accountCredentials: { binding: {} as Ai },
      sessionAffinity: 'session',
      workspace: {} as never,
      runWithKeepAlive: (operation) => operation(),
    });

    expect(piAgentRunner).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'deepseek/deepseek-v4-pro' }));
  });
});

function createResponse() {
  return createChatResponseFromBody({
    body: { messages: [], modelId: '@cf/zai-org/glm-5.2' },
    compaction: { current: null, pending: false, summarize: vi.fn(), save: vi.fn() },
    firstUserMessage: true,
    accountCredentials: { binding: {} as Ai },
    sessionAffinity: 'session',
    workspace: {} as never,
    runWithKeepAlive: (operation) => operation(),
  });
}
