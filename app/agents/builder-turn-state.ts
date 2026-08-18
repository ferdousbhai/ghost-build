import type { ChatRecoveryContext, ChatRecoveryExhaustedContext } from '@cloudflare/ai-chat';
import { messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { BuilderTurnBudgetReport } from '~/lib/.server/llm/builder-turn-budget';

const MAX_PROMPT_PREVIEW_LENGTH = 500;
const MAX_TURN_ERROR_LENGTH = 2_000;
const MAX_TURN_IDENTIFIER_LENGTH = 512;

export type BuilderTurnStatus = 'accepted' | 'recovering' | 'completed' | 'error' | 'aborted';

export type BuilderTurnState = {
  id: string;
  requestId: string;
  chatInitialId: string;
  status: BuilderTurnStatus;
  startedAt: string;
  updatedAt: string;
  continuation: boolean;
  firstUserMessage: boolean;
  messageCount: number;
  lastUserMessagePreview?: string;
  /** Content-free execution accounting for the turn, including why it stopped. */
  budget?: BuilderTurnBudgetReport;
  recovery?: {
    incidentId: string;
    attempt: number;
    recoveryKind: ChatRecoveryContext['recoveryKind'];
    partialTextLength: number;
  };
  error?: string;
};

export function createBuilderTurn(args: {
  requestId: unknown;
  chatInitialId: string;
  continuation: boolean;
  firstUserMessage: boolean;
  messages: GhostbuildMessage[];
}): BuilderTurnState {
  const now = new Date().toISOString();
  const lastUserMessage = args.messages.findLast((message) => message.role === 'user');
  return {
    id: crypto.randomUUID(),
    requestId: boundedIdentifier(args.requestId, crypto.randomUUID()),
    chatInitialId: truncate(args.chatInitialId, MAX_TURN_IDENTIFIER_LENGTH),
    status: 'accepted',
    startedAt: now,
    updatedAt: now,
    continuation: args.continuation,
    firstUserMessage: args.firstUserMessage,
    messageCount: args.messages.length,
    lastUserMessagePreview: lastUserMessage
      ? truncate(messageText(lastUserMessage), MAX_PROMPT_PREVIEW_LENGTH)
      : undefined,
  };
}

export function createRecoveryTurn(context: ChatRecoveryContext, current?: BuilderTurnState | null): BuilderTurnState {
  const updatedAt = new Date().toISOString();
  return {
    ...(current ?? fallbackRecoveryTurn(context)),
    status: 'recovering',
    updatedAt,
    recovery: {
      incidentId: boundedIdentifier(context.incidentId, 'unknown-incident'),
      attempt: context.attempt,
      recoveryKind: context.recoveryKind,
      partialTextLength: context.partialText.length,
    },
  };
}

export function recordBuilderTurnBudget(turn: BuilderTurnState, budget: BuilderTurnBudgetReport): BuilderTurnState {
  return { ...turn, budget, updatedAt: new Date().toISOString() };
}

export function completeBuilderTurn(
  turn: BuilderTurnState,
  result: { status: BuilderTurnStatus; requestId?: string; error?: string },
): BuilderTurnState {
  return {
    ...turn,
    requestId: boundedIdentifier(result.requestId, turn.requestId),
    status: result.status,
    updatedAt: new Date().toISOString(),
    error: result.error === undefined ? undefined : truncate(result.error, MAX_TURN_ERROR_LENGTH),
  };
}

export function exhaustedBuilderTurnResult(
  turn: BuilderTurnState,
  context: ChatRecoveryExhaustedContext,
): { requestId: string; status: 'error'; error: string } | null {
  const matchesIncident = turn.recovery?.incidentId === context.incidentId;
  const matchesRequest = turn.requestId === context.requestId || turn.requestId === context.recoveryRootRequestId;
  if (!matchesIncident && !matchesRequest) {
    return null;
  }
  return {
    requestId: context.requestId,
    status: 'error',
    error: context.terminalMessage,
  };
}

function fallbackRecoveryTurn(context: ChatRecoveryContext): BuilderTurnState {
  return {
    id: boundedIdentifier(context.recoveryRootRequestId, crypto.randomUUID()),
    requestId: boundedIdentifier(context.requestId, crypto.randomUUID()),
    chatInitialId: 'agent-chat',
    status: 'recovering',
    startedAt: new Date(context.createdAt).toISOString(),
    updatedAt: new Date().toISOString(),
    continuation: context.recoveryKind === 'continue',
    firstUserMessage: context.recoveryKind === 'retry',
    messageCount: context.messages.length,
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function boundedIdentifier(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? truncate(value, MAX_TURN_IDENTIFIER_LENGTH) : fallback;
}
