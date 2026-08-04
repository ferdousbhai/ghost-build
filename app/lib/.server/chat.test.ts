import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
const workersAiAgent = vi.hoisted(() => vi.fn());

vi.mock('ghostbuild-agent/utils/logger', () => ({ createScopedLogger: () => logger }));
vi.mock('~/lib/.server/llm/workers-ai-agent', () => ({ workersAiAgent }));

import { createChatResponseFromBody } from './chat';

describe('chat provider error boundary', () => {
  beforeEach(() => {
    logger.error.mockReset();
    logger.info.mockReset();
    workersAiAgent.mockReset();
  });

  it('does not log provider errors or request bodies', async () => {
    workersAiAgent.mockRejectedValueOnce(
      Object.assign(new Error('provider included private request values'), {
        requestBodyValues: { prompt: 'SECRET_PROVIDER_PROMPT' },
      }),
    );

    await expect(
      createChatResponseFromBody({
        body: { chatInitialId: 'chat-id', messages: [], modelId: '@cf/zai-org/glm-5.2' },
        compaction: {
          current: null,
          pending: false,
          summarize: vi.fn(),
          save: vi.fn(),
        },
        env: {} as Env,
        firstUserMessage: true,
        accountCredentials: { binding: {} as Ai },
        sessionAffinity: 'session',
        workspace: {} as never,
        userId: 'user-id',
        agentName: 'agent',
      }),
    ).rejects.toMatchObject({ status: 500 });

    expect(logger.error).toHaveBeenCalledWith('Workers AI chat request failed');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SECRET_PROVIDER_PROMPT');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private request values');
  });

  it('forwards the selected allowlisted model to the builder agent', async () => {
    workersAiAgent.mockResolvedValueOnce(new ReadableStream());

    await createChatResponseFromBody({
      body: { chatInitialId: 'chat-id', messages: [], modelId: 'deepseek/deepseek-v4-pro' },
      compaction: {
        current: null,
        pending: false,
        summarize: vi.fn(),
        save: vi.fn(),
      },
      env: {} as Env,
      firstUserMessage: true,
      accountCredentials: { binding: {} as Ai },
      sessionAffinity: 'session',
      workspace: {} as never,
      userId: 'user-id',
      agentName: 'agent',
    });

    expect(workersAiAgent).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'deepseek/deepseek-v4-pro' }));
  });
});
