import { describe, expect, test } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { buildBuilderAgentRequest } from './builder-agent-request';

const transcript = { agentName: 'chat--transcript-4-2', generation: 2, subchatIndex: 4 };

const messages: GhostbuildMessage[] = [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Build it' }] }];

describe('buildBuilderAgentRequest', () => {
  test('preserves turn-local context while adding agent and subchat identity', () => {
    const turnContext = {
      version: 1 as const,
      content: 'src/index.ts',
    };

    const result = buildBuilderAgentRequest({
      messages,
      body: { turnContext, custom: 'preserved' },
      chatInitialId: 'chat-123',
      subchatIndex: 4,
      transcript,
    });

    expect(result).toEqual({
      turnContext,
      custom: 'preserved',
      chatInitialId: 'chat-123',
      subchatIndex: 4,
      transcript,
      shouldDisableTools: false,
    });
  });

  test('leaves turn-context validation to the server', () => {
    const result = buildBuilderAgentRequest({
      messages,
      body: { turnContext: { version: 2 } },
      chatInitialId: 'chat-123',
      subchatIndex: 0,
      transcript: { agentName: 'chat', generation: 0, subchatIndex: 0 },
    });

    expect(result.turnContext).toEqual({ version: 2 });
  });
});
