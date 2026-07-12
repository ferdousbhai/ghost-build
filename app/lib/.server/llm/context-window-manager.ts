import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import {
  AUTO_COMPACTION_TOKEN_THRESHOLD,
  assembleCompactedContext,
  compactContext,
  createEmergencyContext,
  estimateContextTokens,
  shouldCompactContext,
} from './context-compaction';
import type {
  ContextCompactionAttempt,
  ContextCompactionRepository,
  ContextCompactionState,
} from './context-compaction-store';
import { injectTurnContext } from './turn-context';

const COMPACTION_RETRY_DELAY_MS = 30_000;
const COMPACTION_RETRY_MESSAGE_GROWTH = 8;
const COMPACTION_RETRY_TOKEN_GROWTH_PERCENT = 110;

type ContextWindowLogger = {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
};

type ContextWindowManagerOptions = {
  repository: ContextCompactionRepository;
  summarize: (prompt: string) => Promise<string>;
  systemPrompts: () => string[];
  logger?: ContextWindowLogger;
  now?: () => number;
};

type PreparedModelContext = {
  messages: GhostbuildMessage[];
  contextReduced: boolean;
};

type ContextWindowStatus = {
  scope: string;
  active: boolean;
  generation: number;
  lastAttemptTokens: number;
  lastResultTokens: number;
  lastAttemptStatus: ContextCompactionAttempt['status'];
  lastError: string | null;
  updatedAt: string | null;
  tokenThreshold: number;
};

export class ContextWindowManager {
  constructor(private readonly options: ContextWindowManagerOptions) {}

  initialize(): void {
    this.options.repository.initialize();
  }

  getStatus(scope: string): ContextWindowStatus {
    const state = this.options.repository.getState(scope);
    return {
      scope,
      active: state.compaction !== null,
      generation: state.compaction?.generation ?? 0,
      lastAttemptTokens: state.lastAttempt.tokens,
      lastResultTokens: state.lastAttempt.resultTokens,
      lastAttemptStatus: state.lastAttempt.status,
      lastError: state.lastAttempt.error,
      updatedAt: state.lastAttempt.updatedAt,
      tokenThreshold: AUTO_COMPACTION_TOKEN_THRESHOLD,
    };
  }

  async prepare(
    messages: GhostbuildMessage[],
    scope: string,
    turnContext?: ChatTurnContext,
  ): Promise<PreparedModelContext> {
    const storedState = this.options.repository.getState(scope);
    let assembled = assembleCompactedContext(messages, storedState.compaction);
    const staleCompaction = storedState.compaction !== null && !assembled.overlayApplied;
    if (staleCompaction) {
      this.options.repository.clearCompaction(scope);
    }
    const state = staleCompaction ? stateWithoutStaleCompaction() : storedState;
    const systemPrompts = this.options.systemPrompts();
    let estimatedTokens = estimateModelViewTokens(assembled.messages, systemPrompts, turnContext);
    if (!shouldCompactContext(estimatedTokens)) {
      return preparedContext(assembled.messages, assembled.overlayApplied, turnContext);
    }

    if (!shouldRetryCompaction(state, assembled.messages.length, estimatedTokens, this.now())) {
      return this.fallbackContext(assembled.messages, assembled.overlayApplied, turnContext);
    }

    const attemptedTokens = estimatedTokens;
    const attemptedMessageCount = assembled.messages.length;
    this.options.repository.recordAttempt(
      scope,
      {
        status: 'running',
        attemptedTokens,
        attemptedMessageCount,
        resultTokens: estimatedTokens,
      },
      state.compaction,
    );
    this.options.logger?.info('Starting automatic Ghostbuild context compaction', {
      scope,
      estimatedTokens,
      messageCount: attemptedMessageCount,
    });

    try {
      const next = await compactContext({
        messages,
        current: state.compaction,
        summarize: this.options.summarize,
      });

      if (!next) {
        this.options.repository.recordAttempt(
          scope,
          {
            status: 'noop',
            attemptedTokens,
            attemptedMessageCount,
            resultTokens: estimatedTokens,
          },
          state.compaction,
        );
        this.options.logger?.warn('Automatic context compaction returned no summary', {
          estimatedTokens,
          messageCount: attemptedMessageCount,
        });
        return this.fallbackContext(assembled.messages, assembled.overlayApplied, turnContext);
      }

      assembled = assembleCompactedContext(messages, next);
      estimatedTokens = estimateModelViewTokens(assembled.messages, systemPrompts, turnContext);
      this.options.repository.saveCompaction(scope, next, {
        attemptedTokens,
        attemptedMessageCount,
        resultTokens: estimatedTokens,
      });
      this.options.logger?.info('Automatically compacted Ghostbuild context', {
        scope,
        generation: next.generation,
        tokensBefore: attemptedTokens,
        tokensAfter: estimatedTokens,
        messagesBefore: attemptedMessageCount,
        messagesAfter: assembled.messages.length,
      });

      return preparedContext(assembled.messages, assembled.overlayApplied, turnContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.repository.recordAttempt(
        scope,
        {
          status: 'error',
          attemptedTokens,
          attemptedMessageCount,
          resultTokens: estimatedTokens,
          error: message,
        },
        state.compaction,
      );
      this.options.logger?.warn('Automatic context compaction failed; using a bounded prompt fallback', {
        error: message,
        scope,
        estimatedTokens,
      });
      return this.fallbackContext(assembled.messages, assembled.overlayApplied, turnContext);
    }
  }

  private fallbackContext(
    messages: GhostbuildMessage[],
    overlayApplied: boolean,
    turnContext?: ChatTurnContext,
  ): PreparedModelContext {
    const fallback = createEmergencyContext(messages);
    return preparedContext(fallback, overlayApplied || fallback !== messages, turnContext);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function preparedContext(
  messages: GhostbuildMessage[],
  contextReduced: boolean,
  turnContext?: ChatTurnContext,
): PreparedModelContext {
  return { messages: injectTurnContext(messages, turnContext), contextReduced };
}

function estimateModelViewTokens(
  messages: GhostbuildMessage[],
  systemPrompts: string[],
  turnContext?: ChatTurnContext,
): number {
  return estimateContextTokens(injectTurnContext(messages, turnContext), systemPrompts);
}

function stateWithoutStaleCompaction(): ContextCompactionState {
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

export function shouldRetryCompaction(
  state: ContextCompactionState,
  messageCount: number,
  estimatedTokens: number,
  now: number,
): boolean {
  const attempt = state.lastAttempt;
  if (attempt.status !== 'noop' && attempt.status !== 'error') {
    return true;
  }

  const attemptedAt = attempt.updatedAt ? Date.parse(attempt.updatedAt) : Number.NaN;
  if (!Number.isFinite(attemptedAt) || now - attemptedAt >= COMPACTION_RETRY_DELAY_MS) {
    return true;
  }
  if (messageCount >= attempt.messageCount + COMPACTION_RETRY_MESSAGE_GROWTH) {
    return true;
  }
  return estimatedTokens * 100 >= attempt.tokens * COMPACTION_RETRY_TOKEN_GROWTH_PERCENT;
}
