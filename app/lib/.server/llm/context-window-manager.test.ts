import { describe, expect, test, vi } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type {
  ContextAttemptInput,
  ContextCompactionRepository,
  ContextCompactionState,
} from './context-compaction-store';
import { ContextWindowManager, shouldRetryCompaction } from './context-window-manager';
import { AUTO_COMPACTION_TOKEN_THRESHOLD, estimateContextTokens, type ContextCompaction } from './context-compaction';
import { injectTurnContext } from './turn-context';

class MemoryContextRepository implements ContextCompactionRepository {
  initialized = false;
  states = new Map<string, ContextCompactionState>();
  attempts: ContextAttemptInput[] = [];

  get state(): ContextCompactionState {
    return this.getState('subchat:0');
  }

  initialize(): void {
    this.initialized = true;
  }

  getState(scope: string): ContextCompactionState {
    return this.states.get(scope) ?? emptyState();
  }

  clearCompaction(scope: string): void {
    this.states.set(scope, emptyState());
  }

  saveCompaction(
    scope: string,
    compaction: ContextCompaction,
    attempt: { attemptedTokens: number; attemptedMessageCount: number; resultTokens: number },
  ): void {
    this.states.set(scope, {
      compaction,
      lastAttempt: {
        tokens: attempt.attemptedTokens,
        messageCount: attempt.attemptedMessageCount,
        resultTokens: attempt.resultTokens,
        status: 'compacted',
        error: null,
        updatedAt: new Date(0).toISOString(),
      },
    });
  }

  recordAttempt(scope: string, attempt: ContextAttemptInput, current?: ContextCompaction | null): void {
    this.attempts.push(attempt);
    this.states.set(scope, {
      ...this.getState(scope),
      compaction: current ?? this.getState(scope).compaction,
      lastAttempt: {
        tokens: attempt.attemptedTokens,
        messageCount: attempt.attemptedMessageCount,
        resultTokens: attempt.resultTokens,
        status: attempt.status,
        error: attempt.error ?? null,
        updatedAt: new Date(0).toISOString(),
      },
    });
  }
}

function message(id: string, text: string): GhostbuildMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

function largeHistory(count = 48): GhostbuildMessage[] {
  return Array.from({ length: count }, (_, index) => message(`m-${index}`, 'x'.repeat(20_000)));
}

function emptyState(): ContextCompactionState {
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

describe('ContextWindowManager', () => {
  test('keeps small contexts unchanged', async () => {
    const repository = new MemoryContextRepository();
    const summarize = vi.fn(async (_prompt: string) => 'summary');
    const manager = new ContextWindowManager({ repository, summarize, systemPrompts: () => [] });
    const messages = [message('m-1', 'hello')];

    manager.initialize();
    const result = await manager.prepare(messages, 'subchat:0');

    expect(repository.initialized).toBe(true);
    expect(result.messages).toBe(messages);
    expect(result.contextReduced).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
  });

  test('persists a summary through the repository and returns the overlaid context', async () => {
    const repository = new MemoryContextRepository();
    const manager = new ContextWindowManager({
      repository,
      summarize: async (_prompt) => '## Current State\nCompacted.',
      systemPrompts: () => [],
    });

    const result = await manager.prepare(largeHistory(), 'subchat:0');

    expect(repository.state.compaction?.summary).toContain('Compacted');
    expect(repository.state.lastAttempt.status).toBe('compacted');
    expect(result.contextReduced).toBe(true);
    expect(result.messages.length).toBeLessThan(48);
  });

  test('uses the full model-view budget to trigger compaction without summarizing turn-local context', async () => {
    const repository = new MemoryContextRepository();
    const summarize = vi.fn(async (_prompt: string) => 'summary');
    const manager = new ContextWindowManager({ repository, summarize, systemPrompts: () => [] });
    const messages = Array.from({ length: 20 }, (_, index) => message(`m-${index}`, 'x'.repeat(18_000)));
    const turnContext = {
      version: 1 as const,
      content: `ephemeral-workspace:${'y'.repeat(79_000)}`,
    };

    expect(estimateContextTokens(messages)).toBeLessThanOrEqual(AUTO_COMPACTION_TOKEN_THRESHOLD);
    expect(estimateContextTokens(injectTurnContext(messages, turnContext))).toBeGreaterThan(
      AUTO_COMPACTION_TOKEN_THRESHOLD,
    );

    const result = await manager.prepare(messages, 'subchat:0', turnContext);

    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize.mock.calls[0]?.[0]).not.toContain('ephemeral-workspace');
    expect(repository.state.compaction?.summary).toBe('summary');
    expect(JSON.stringify(result.messages)).toContain('ephemeral-workspace');
    expect(JSON.stringify(messages)).not.toContain('ephemeral-workspace');
  });

  test('never includes turn-local context in the persisted summary prompt', async () => {
    const repository = new MemoryContextRepository();
    const summarize = vi.fn(async (_prompt: string) => 'durable summary');
    const manager = new ContextWindowManager({ repository, summarize, systemPrompts: () => [] });
    const turnContext = {
      version: 1 as const,
      content: 'ephemeral-workspace:do-not-persist',
    };

    const result = await manager.prepare(largeHistory(), 'subchat:0', turnContext);

    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize.mock.calls[0]?.[0]).not.toContain('ephemeral-workspace');
    expect(repository.state.compaction?.summary).toBe('durable summary');
    expect(JSON.stringify(result.messages)).toContain('ephemeral-workspace:do-not-persist');
  });

  test('records summary failures and returns a bounded non-persistent fallback', async () => {
    const repository = new MemoryContextRepository();
    const manager = new ContextWindowManager({
      repository,
      summarize: async () => {
        throw new Error('summary unavailable');
      },
      systemPrompts: () => [],
    });
    const messages = largeHistory();

    const result = await manager.prepare(messages, 'subchat:0');

    expect(repository.attempts).toContainEqual(
      expect.objectContaining({ status: 'error', error: 'summary unavailable' }),
    );
    expect(result.contextReduced).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(messages).toHaveLength(48);
  });

  test('applies the bounded fallback when combined durable and turn-local context exceeds the budget', async () => {
    const repository = new MemoryContextRepository();
    const summarize = vi.fn(async (prompt: string) => {
      expect(prompt).not.toContain('ephemeral-workspace');
      throw new Error('summary unavailable');
    });
    const manager = new ContextWindowManager({ repository, summarize, systemPrompts: () => [] });
    const messages = Array.from({ length: 20 }, (_, index) => message(`m-${index}`, 'x'.repeat(18_000)));
    const turnContext = {
      version: 1 as const,
      content: `ephemeral-workspace:${'y'.repeat(79_000)}`,
    };

    const result = await manager.prepare(messages, 'subchat:0', turnContext);

    expect(summarize).toHaveBeenCalledOnce();
    expect(repository.state.compaction).toBeNull();
    expect(result.contextReduced).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(JSON.stringify(result.messages)).toContain('ephemeral-workspace');
    expect(JSON.stringify(messages)).not.toContain('ephemeral-workspace');
  });

  test('keeps compaction state independent between subchats', async () => {
    const repository = new MemoryContextRepository();
    let summary = 'summary-a';
    const manager = new ContextWindowManager({
      repository,
      summarize: async () => summary,
      systemPrompts: () => [],
    });

    await manager.prepare(largeHistory(), 'subchat:0');
    summary = 'summary-b';
    await manager.prepare(largeHistory(), 'subchat:1');

    expect(repository.getState('subchat:0').compaction?.summary).toBe('summary-a');
    expect(repository.getState('subchat:1').compaction?.summary).toBe('summary-b');
  });

  test('does not let a stale rewound compaction suppress a new summary', async () => {
    const repository = new MemoryContextRepository();
    repository.states.set('subchat:0', {
      compaction: {
        summary: 'later branch',
        fromMessageId: 'missing-start',
        toMessageId: 'missing-end',
        generation: 3,
      },
      lastAttempt: {
        tokens: 200_000,
        messageCount: 48,
        resultTokens: 200_000,
        status: 'error',
        error: 'later branch failure',
        updatedAt: new Date(1_000).toISOString(),
      },
    });
    const summarize = vi.fn(async (prompt: string) => {
      expect(prompt).not.toContain('LATER_BRANCH_SECRET');
      return 'rewound branch summary';
    });
    const manager = new ContextWindowManager({ repository, summarize, systemPrompts: () => [], now: () => 1_001 });

    await manager.prepare(largeHistory(), 'subchat:0');

    expect(summarize).toHaveBeenCalledOnce();
    expect(repository.getState('subchat:0').compaction?.generation).toBe(1);
  });

  test('clears stale rewound compaction even when the new branch is below the token threshold', async () => {
    const repository = new MemoryContextRepository();
    repository.states.set('subchat:0', {
      compaction: {
        summary: 'later branch',
        fromMessageId: 'missing-start',
        toMessageId: 'missing-end',
        generation: 3,
      },
      lastAttempt: {
        tokens: 120_000,
        messageCount: 30,
        resultTokens: 40_000,
        status: 'compacted',
        error: null,
        updatedAt: new Date(1_000).toISOString(),
      },
    });
    const summarize = vi.fn(async () => 'unused');
    const manager = new ContextWindowManager({ repository, summarize, systemPrompts: () => [] });
    const messages = [message('rewound-user', 'small branch')];

    const result = await manager.prepare(messages, 'subchat:0');

    expect(result.messages).toBe(messages);
    expect(repository.getState('subchat:0')).toEqual(emptyState());
    expect(manager.getStatus('subchat:0')).toMatchObject({ active: false, generation: 0, lastAttemptStatus: 'idle' });
    expect(JSON.stringify(result.messages)).not.toContain('LATER_BRANCH_SECRET');
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe('shouldRetryCompaction', () => {
  test('backs off unchanged failures and re-arms after growth', () => {
    const state: ContextCompactionState = {
      compaction: null,
      lastAttempt: {
        tokens: 100_000,
        messageCount: 20,
        resultTokens: 100_000,
        status: 'error',
        error: 'failed',
        updatedAt: new Date(1_000).toISOString(),
      },
    };

    expect(shouldRetryCompaction(state, 20, 100_000, 2_000)).toBe(false);
    expect(shouldRetryCompaction(state, 28, 100_000, 2_000)).toBe(true);
    expect(shouldRetryCompaction(state, 20, 110_000, 2_000)).toBe(true);
    expect(shouldRetryCompaction(state, 20, 100_000, 31_000)).toBe(true);
  });
});
