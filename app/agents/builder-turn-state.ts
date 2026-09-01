import type { ChatRecoveryContext, ChatRecoveryExhaustedContext } from '@cloudflare/ai-chat';

const MAX_TURN_IDENTIFIER_LENGTH = 512;

export type BuilderTurnStatus = 'accepted' | 'recovering' | 'completed' | 'error' | 'aborted';

export type BuilderTurnState = {
  id: string;
  requestId: string;
  status: BuilderTurnStatus;
  recovery?: { incidentId: string };
};

export function createBuilderTurn(requestId: string | undefined): BuilderTurnState {
  return {
    id: crypto.randomUUID(),
    requestId: boundedIdentifier(requestId, crypto.randomUUID()),
    status: 'accepted',
  };
}

export function createRecoveryTurn(context: ChatRecoveryContext, current?: BuilderTurnState | null): BuilderTurnState {
  return {
    id: current?.id ?? boundedIdentifier(context.recoveryRootRequestId, crypto.randomUUID()),
    requestId: current?.requestId ?? boundedIdentifier(context.requestId, crypto.randomUUID()),
    status: 'recovering',
    recovery: { incidentId: boundedIdentifier(context.incidentId, 'unknown-incident') },
  };
}

export function completeBuilderTurn(
  turn: BuilderTurnState,
  result: { status: BuilderTurnStatus; requestId?: string },
): BuilderTurnState {
  return {
    ...turn,
    requestId: boundedIdentifier(result.requestId, turn.requestId),
    status: result.status,
  };
}

export function exhaustedBuilderTurnResult(
  turn: BuilderTurnState,
  context: ChatRecoveryExhaustedContext,
): { requestId: string; status: 'error' } | null {
  const matchesIncident = turn.recovery?.incidentId === context.incidentId;
  const matchesRequest = turn.requestId === context.requestId || turn.requestId === context.recoveryRootRequestId;
  if (!matchesIncident && !matchesRequest) {
    return null;
  }
  return {
    requestId: context.requestId,
    status: 'error',
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function boundedIdentifier(value: string | undefined, fallback: string): string {
  return value ? truncate(value, MAX_TURN_IDENTIFIER_LENGTH) : fallback;
}
