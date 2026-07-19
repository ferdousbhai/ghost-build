import type { ChatRecoveryContext } from '@cloudflare/ai-chat';
import type { SqlProvider } from 'agents/experimental/memory/session';
import { messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

const MAX_PROMPT_PREVIEW_LENGTH = 500;
const MAX_PERSISTED_TURNS = 100;
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
  recovery?: {
    incidentId: string;
    attempt: number;
    recoveryKind: ChatRecoveryContext['recoveryKind'];
    partialTextLength: number;
  };
  error?: string;
};

type PersistedTurnRow = {
  id: string;
  request_id: string;
  chat_initial_id: string;
  status: BuilderTurnStatus;
  started_at: string;
  updated_at: string;
  continuation: number;
  first_user_message: number;
  message_count: number;
  last_user_message_preview: string | null;
  recovery_incident_id: string | null;
  recovery_attempt: number | null;
  recovery_kind: string | null;
  partial_text_length: number | null;
  error: string | null;
};

export class BuilderTurnStore {
  constructor(private readonly db: SqlProvider) {}

  initialize(): void {
    void this.db.sql`
      CREATE TABLE IF NOT EXISTS builder_turns (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        chat_initial_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        continuation INTEGER NOT NULL,
        first_user_message INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        last_user_message_preview TEXT,
        recovery_incident_id TEXT,
        recovery_attempt INTEGER,
        recovery_kind TEXT,
        partial_text_length INTEGER,
        error TEXT
      )
    `;
  }

  record(turn: BuilderTurnState): void {
    void this.db.sql`
      INSERT OR REPLACE INTO builder_turns (
        id, request_id, chat_initial_id, status, started_at, updated_at,
        continuation, first_user_message, message_count, last_user_message_preview,
        recovery_incident_id, recovery_attempt, recovery_kind, partial_text_length, error
      ) VALUES (
        ${turn.id},
        ${turn.requestId},
        ${turn.chatInitialId},
        ${turn.status},
        ${turn.startedAt},
        ${turn.updatedAt},
        ${turn.continuation ? 1 : 0},
        ${turn.firstUserMessage ? 1 : 0},
        ${turn.messageCount},
        ${turn.lastUserMessagePreview ?? null},
        ${turn.recovery?.incidentId ?? null},
        ${turn.recovery?.attempt ?? null},
        ${turn.recovery?.recoveryKind ?? null},
        ${turn.recovery?.partialTextLength ?? null},
        ${turn.error ?? null}
      )
    `;
    void this.db.sql`
      DELETE FROM builder_turns
      WHERE id IN (
        SELECT id
        FROM builder_turns
        ORDER BY updated_at DESC
        LIMIT -1 OFFSET ${MAX_PERSISTED_TURNS}
      )
    `;
  }

  getHistory(limit: number): PersistedTurnRow[] {
    return this.db.sql<PersistedTurnRow>`
      SELECT *
      FROM builder_turns
      ORDER BY updated_at DESC
      LIMIT ${boundedHistoryLimit(limit)}
    `;
  }
}

function boundedHistoryLimit(limit: number, fallback = 20): number {
  const numericLimit = Number.isFinite(limit) ? limit : fallback;
  return Math.min(Math.max(Math.trunc(numericLimit), 1), 50);
}

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
