import { describe, expect, it } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { ChatRecoveryExhaustedContext } from '@cloudflare/ai-chat';
import { completeBuilderTurn, createBuilderTurn, exhaustedBuilderTurnResult } from './builder-turn-state';

describe('builder turn state', () => {
  it('bounds identifiers, prompt previews, and terminal errors', () => {
    const turn = createBuilderTurn({
      requestId: 'r'.repeat(1_000),
      chatInitialId: 'c'.repeat(1_000),
      continuation: false,
      firstUserMessage: true,
      messages: [message('m', 'p'.repeat(1_000))],
    });
    const completed = completeBuilderTurn(turn, {
      status: 'error',
      requestId: 'n'.repeat(1_000),
      error: 'e'.repeat(4_000),
    });

    expect(turn.requestId).toHaveLength(512);
    expect(turn.chatInitialId).toHaveLength(512);
    expect(turn.lastUserMessagePreview).toHaveLength(500);
    expect(completed.requestId).toHaveLength(512);
    expect(completed.error).toHaveLength(2_000);
  });

  it('terminalizes only the active turn that belongs to the exhausted recovery', () => {
    const turn = createBuilderTurn({
      requestId: 'root-request',
      chatInitialId: 'chat',
      continuation: false,
      firstUserMessage: true,
      messages: [message('m', 'hello')],
    });
    const context = recoveryExhaustedContext();

    expect(exhaustedBuilderTurnResult(turn, context)).toEqual({
      requestId: 'recovery-request',
      status: 'error',
      error: 'The builder was interrupted.',
    });
    expect(exhaustedBuilderTurnResult({ ...turn, requestId: 'newer-request' }, context)).toBeNull();
    expect(
      exhaustedBuilderTurnResult(
        {
          ...turn,
          requestId: 'newer-request',
          recovery: { incidentId: 'incident', attempt: 1, recoveryKind: 'continue', partialTextLength: 1 },
        },
        context,
      ),
    ).toEqual({
      requestId: 'recovery-request',
      status: 'error',
      error: 'The builder was interrupted.',
    });
  });
});

function recoveryExhaustedContext(): ChatRecoveryExhaustedContext {
  return {
    incidentId: 'incident',
    requestId: 'recovery-request',
    recoveryRootRequestId: 'root-request',
    attempt: 2,
    maxAttempts: 2,
    recoveryKind: 'continue',
    streamId: 'stream',
    createdAt: Date.now(),
    partialText: '',
    partialParts: [],
    reason: 'recovery_aborted',
    terminalMessage: 'The builder was interrupted.',
  };
}

function message(id: string, text: string): GhostbuildMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}
