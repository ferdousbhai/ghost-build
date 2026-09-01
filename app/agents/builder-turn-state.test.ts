import { describe, expect, it } from 'vitest';
import type { ChatRecoveryExhaustedContext } from '@cloudflare/ai-chat';
import { completeBuilderTurn, createBuilderTurn, exhaustedBuilderTurnResult } from './builder-turn-state';

describe('builder turn state', () => {
  it('bounds turn identifiers', () => {
    const turn = createBuilderTurn('r'.repeat(1_000));
    const completed = completeBuilderTurn(turn, {
      status: 'error',
      requestId: 'n'.repeat(1_000),
    });

    expect(turn.requestId).toHaveLength(512);
    expect(completed.requestId).toHaveLength(512);
  });

  it('terminalizes only the active turn that belongs to the exhausted recovery', () => {
    const turn = createBuilderTurn('root-request');
    const context = recoveryExhaustedContext();

    expect(exhaustedBuilderTurnResult(turn, context)).toEqual({
      requestId: 'recovery-request',
      status: 'error',
    });
    expect(exhaustedBuilderTurnResult({ ...turn, requestId: 'newer-request' }, context)).toBeNull();
    expect(
      exhaustedBuilderTurnResult(
        {
          ...turn,
          requestId: 'newer-request',
          recovery: { incidentId: 'incident' },
        },
        context,
      ),
    ).toEqual({
      requestId: 'recovery-request',
      status: 'error',
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
