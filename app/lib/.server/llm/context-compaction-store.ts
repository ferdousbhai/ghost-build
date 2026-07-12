import type { SqlProvider } from 'agents/experimental/memory/session';
import type { ContextCompaction } from './context-compaction';

const LEGACY_CONTEXT_ID = 'active';
const DEFAULT_CONTEXT_SCOPE = 'subchat:0';

export type ContextAttemptStatus = 'idle' | 'running' | 'compacted' | 'noop' | 'error';

export type ContextCompactionAttempt = {
  tokens: number;
  messageCount: number;
  resultTokens: number;
  status: ContextAttemptStatus;
  error: string | null;
  updatedAt: string | null;
};

export type ContextCompactionState = {
  compaction: ContextCompaction | null;
  lastAttempt: ContextCompactionAttempt;
};

export type ContextAttemptInput = {
  status: Extract<ContextAttemptStatus, 'running' | 'noop' | 'error'>;
  attemptedTokens: number;
  attemptedMessageCount: number;
  resultTokens: number;
  error?: string;
};

export interface ContextCompactionRepository {
  initialize(): void;
  getState(scope: string): ContextCompactionState;
  clearCompaction(scope: string): void;
  saveCompaction(
    scope: string,
    compaction: ContextCompaction,
    attempt: { attemptedTokens: number; attemptedMessageCount: number; resultTokens: number },
  ): void;
  recordAttempt(scope: string, attempt: ContextAttemptInput, current?: ContextCompaction | null): void;
}

type ContextStateRow = {
  summary: string | null;
  from_message_id: string | null;
  to_message_id: string | null;
  generation: number;
  last_attempt_tokens: number;
  last_attempt_message_count: number;
  last_result_tokens: number;
  last_attempt_status: ContextAttemptStatus;
  last_error: string | null;
  updated_at: string;
};

export class DurableObjectContextCompactionRepository implements ContextCompactionRepository {
  constructor(private readonly db: SqlProvider) {}

  initialize(): void {
    void this.db.sql`
      CREATE TABLE IF NOT EXISTS builder_context_state (
        id TEXT PRIMARY KEY,
        summary TEXT,
        from_message_id TEXT,
        to_message_id TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        last_attempt_tokens INTEGER NOT NULL DEFAULT 0,
        last_attempt_message_count INTEGER NOT NULL DEFAULT 0,
        last_result_tokens INTEGER NOT NULL DEFAULT 0,
        last_attempt_status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

    const now = new Date().toISOString();
    void this.db.sql`
      INSERT OR IGNORE INTO builder_context_state (
        id, summary, from_message_id, to_message_id, generation,
        last_attempt_tokens, last_attempt_message_count, last_result_tokens,
        last_attempt_status, last_error, created_at, updated_at
      ) VALUES (${LEGACY_CONTEXT_ID}, NULL, NULL, NULL, 0, 0, 0, 0, 'idle', NULL, ${now}, ${now})
    `;
  }

  getState(scope: string): ContextCompactionState {
    const scopedRow = this.db.sql<ContextStateRow>`
      SELECT summary, from_message_id, to_message_id, generation,
             last_attempt_tokens, last_attempt_message_count, last_result_tokens,
             last_attempt_status, last_error, updated_at
      FROM builder_context_state
      WHERE id = ${scope}
      LIMIT 1
    `[0];
    const row =
      scopedRow ??
      (scope === DEFAULT_CONTEXT_SCOPE
        ? this.db.sql<ContextStateRow>`
            SELECT summary, from_message_id, to_message_id, generation,
                   last_attempt_tokens, last_attempt_message_count, last_result_tokens,
                   last_attempt_status, last_error, updated_at
            FROM builder_context_state
            WHERE id = ${LEGACY_CONTEXT_ID}
            LIMIT 1
          `[0]
        : undefined);

    if (!row) {
      return emptyContextState();
    }

    return {
      compaction: compactionFromRow(row),
      lastAttempt: {
        tokens: row.last_attempt_tokens,
        messageCount: row.last_attempt_message_count,
        resultTokens: row.last_result_tokens,
        status: row.last_attempt_status,
        error: row.last_error,
        updatedAt: row.updated_at,
      },
    };
  }

  clearCompaction(scope: string): void {
    const updatedAt = new Date().toISOString();
    void this.db.sql`
      INSERT INTO builder_context_state (
        id, summary, from_message_id, to_message_id, generation,
        last_attempt_tokens, last_attempt_message_count, last_result_tokens,
        last_attempt_status, last_error, created_at, updated_at
      ) VALUES (${scope}, NULL, NULL, NULL, 0, 0, 0, 0, 'idle', NULL, ${updatedAt}, ${updatedAt})
      ON CONFLICT(id) DO UPDATE SET
        summary = NULL,
        from_message_id = NULL,
        to_message_id = NULL,
        generation = 0,
        last_attempt_tokens = 0,
        last_attempt_message_count = 0,
        last_result_tokens = 0,
        last_attempt_status = 'idle',
        last_error = NULL,
        updated_at = excluded.updated_at
    `;
  }

  saveCompaction(
    scope: string,
    compaction: ContextCompaction,
    attempt: { attemptedTokens: number; attemptedMessageCount: number; resultTokens: number },
  ): void {
    const updatedAt = new Date().toISOString();
    void this.db.sql`
      INSERT INTO builder_context_state (
        id, summary, from_message_id, to_message_id, generation,
        last_attempt_tokens, last_attempt_message_count, last_result_tokens,
        last_attempt_status, last_error, created_at, updated_at
      ) VALUES (
        ${scope}, ${compaction.summary}, ${compaction.fromMessageId}, ${compaction.toMessageId}, ${compaction.generation},
        ${attempt.attemptedTokens}, ${attempt.attemptedMessageCount}, ${attempt.resultTokens},
        'compacted', NULL, ${updatedAt}, ${updatedAt}
      ) ON CONFLICT(id) DO UPDATE SET
        summary = excluded.summary,
        from_message_id = excluded.from_message_id,
        to_message_id = excluded.to_message_id,
        generation = excluded.generation,
        last_attempt_tokens = excluded.last_attempt_tokens,
        last_attempt_message_count = excluded.last_attempt_message_count,
        last_result_tokens = excluded.last_result_tokens,
        last_attempt_status = excluded.last_attempt_status,
        last_error = NULL,
        updated_at = excluded.updated_at
    `;
  }

  recordAttempt(scope: string, attempt: ContextAttemptInput, current?: ContextCompaction | null): void {
    const updatedAt = new Date().toISOString();
    void this.db.sql`
      INSERT INTO builder_context_state (
        id, summary, from_message_id, to_message_id, generation,
        last_attempt_tokens, last_attempt_message_count, last_result_tokens,
        last_attempt_status, last_error, created_at, updated_at
      ) VALUES (
        ${scope}, ${current?.summary ?? null}, ${current?.fromMessageId ?? null}, ${current?.toMessageId ?? null},
        ${current?.generation ?? 0}, ${attempt.attemptedTokens}, ${attempt.attemptedMessageCount},
        ${attempt.resultTokens}, ${attempt.status}, ${attempt.error ?? null}, ${updatedAt}, ${updatedAt}
      ) ON CONFLICT(id) DO UPDATE SET
        last_attempt_tokens = excluded.last_attempt_tokens,
        last_attempt_message_count = excluded.last_attempt_message_count,
        last_result_tokens = excluded.last_result_tokens,
        last_attempt_status = excluded.last_attempt_status,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `;
  }
}

export function contextScopeForSubchat(subchatIndex: number): string {
  return `subchat:${subchatIndex}`;
}

function compactionFromRow(row: ContextStateRow): ContextCompaction | null {
  if (!row.summary || !row.from_message_id || !row.to_message_id) {
    return null;
  }
  return {
    summary: row.summary,
    fromMessageId: row.from_message_id,
    toMessageId: row.to_message_id,
    generation: row.generation,
  };
}

function emptyContextState(): ContextCompactionState {
  return {
    compaction: null,
    lastAttempt: {
      tokens: 0,
      messageCount: 0,
      resultTokens: 0,
      status: 'idle',
      error: null,
      updatedAt: null,
    },
  };
}
