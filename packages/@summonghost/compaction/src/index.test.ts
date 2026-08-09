import { describe, expect, it } from 'vitest';
import {
  canApplyConversationCompaction,
  ConversationCompactionLimitError,
  ConversationCompactionSupersededError,
  conversationCompactionKey,
  createConversationCompactionController,
  decideConversationCompaction,
} from './index.js';

const policy = {
  proactiveTokens: 80_000,
  hardLimitTokens: 100_000,
  headroomTokens: 5_000,
};

describe('conversation compaction policy', () => {
  it('schedules early, deduplicates pending work, and blocks only at the hard limit', () => {
    expect(decideConversationCompaction({ estimatedTokens: 70_000, policy })).toBe('none');
    expect(decideConversationCompaction({ estimatedTokens: 76_000, policy })).toBe('background');
    expect(
      decideConversationCompaction({
        estimatedTokens: 76_000,
        pending: true,
        policy,
      }),
    ).toBe('none');
    expect(
      decideConversationCompaction({
        estimatedTokens: 95_000,
        pending: true,
        policy,
      }),
    ).toBe('blocking');
  });

  it('creates stable scope-and-anchor keys', () => {
    expect(
      conversationCompactionKey({
        scope: 'conversation/a',
        throughId: 'message:9',
        revision: 4,
      }),
    ).toBe('conversation-compaction:conversation%2Fa:message%3A9:4');
  });

  it('applies only an anchored compaction that advances the checkpoint', () => {
    const currentMessageIds = ['a', 'b', 'c', 'tail'];
    expect(
      canApplyConversationCompaction({
        expectedFromId: 'a',
        expectedThroughId: 'c',
        currentMessageIds,
      }),
    ).toBe(true);
    expect(
      canApplyConversationCompaction({
        expectedFromId: 'a',
        expectedThroughId: 'c',
        currentMessageIds,
        currentThroughId: 'c',
      }),
    ).toBe(false);
    expect(
      canApplyConversationCompaction({
        expectedFromId: 'missing',
        expectedThroughId: 'c',
        currentMessageIds,
      }),
    ).toBe(false);
  });
});

describe('conversation compaction controller', () => {
  it('runs proactive work through the scheduler and applies blocking snapshots', async () => {
    let scheduledRun: (() => Promise<string>) | undefined;
    const counts = [85_000, 85_000, 100_000];
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [`summary:${snapshot}`],
      countInputTokens: async () => counts.shift() ?? 0,
      createSnapshot: async ({ messages, sequence }) => `${sequence}:${messages.join('|')}`,
      policy,
      scheduleCompaction: async ({ run }) => {
        scheduledRun = run;
      },
    });

    await expect(controller.prepareMessages(['a', 'b'])).resolves.toEqual(['a', 'b']);
    expect(controller.pending()).toBe(true);
    expect(controller.snapshotSequence()).toBe(1);
    await expect(scheduledRun?.()).resolves.toBe('1:a|b');
    expect(controller.pending()).toBe(true);
    expect(controller.latestSnapshot()).toBeNull();
    await expect(controller.prepareMessages(['a', 'b', 'c'])).resolves.toEqual(['a', 'b', 'c']);
    expect(controller.snapshotSequence()).toBe(1);
    await expect(controller.prepareMessages(['a', 'b', 'c', 'd'])).resolves.toEqual(['summary:2:a|b|c|d']);
    expect(controller.snapshotSequence()).toBe(2);
    expect(controller.latestSnapshot()).toBe('2:a|b|c|d');

    const blocking = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [`summary:${snapshot}`],
      countInputTokens: async ({ messages }) => (messages[0]?.startsWith('summary:') ? 1_000 : 100_000),
      createSnapshot: async ({ messages, sequence }) => `${sequence}:${messages.join('|')}`,
      policy,
    });
    await expect(blocking.prepareMessages(['a', 'b'])).resolves.toEqual(['summary:1:a|b']);
    expect(blocking.latestSnapshot()).toBe('1:a|b');
  });

  it('does not run proactive work without a scheduler', async () => {
    let compactions = 0;
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens: async () => 85_000,
      createSnapshot: async () => {
        compactions += 1;
        return 'summary';
      },
      policy,
    });

    await expect(controller.prepareMessages(['a'])).resolves.toEqual(['a']);
    expect(compactions).toBe(0);
    expect(controller.pending()).toBe(false);
  });

  it('appends verified suffixes and resets on same-length history changes', async () => {
    const measured: string[][] = [];
    const controller = createConversationCompactionController<Readonly<{ id: string; text: string }>, string>({
      applySnapshot: ({ snapshot }) => [{ id: 'summary', text: snapshot }],
      countInputTokens: async ({ messages }) => {
        measured.push(messages.map((message) => message.id));
        return measured.length === 1 ? 100_000 : 10;
      },
      createSnapshot: async ({ messages }) => messages.map((message) => message.text).join(' '),
      messagesEqual: (left, right) => left.id === right.id && left.text === right.text,
      policy,
    });

    const first = [{ id: 'a', text: 'one' }];
    await controller.prepareMessages(first);
    await controller.prepareMessages([...first, { id: 'b', text: 'two' }]);
    await controller.prepareMessages([{ id: 'a', text: 'changed' }]);

    expect(measured).toEqual([['a'], ['summary'], ['summary', 'b'], ['a']]);
    expect(controller.latestSnapshot()).toBeNull();
  });

  it('rejects a blocking replacement that still reaches the hard limit', async () => {
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: () => ['summary'],
      countInputTokens: async () => 100_000,
      createSnapshot: async () => 'oversized',
      policy,
    });

    const error = await controller
      .prepareMessages(['a'])
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConversationCompactionLimitError);
    expect(error).toMatchObject({
      code: 'conversation_compaction_limit',
      hardLimitTokens: 100_000,
      headroomTokens: 5_000,
      replacementTokens: 100_000,
    });
    expect(controller.latestSnapshot()).toBeNull();
  });

  it('rejects a background run after its history branch is replaced', async () => {
    const scheduledRuns: Array<() => Promise<string>> = [];
    const controller = createConversationCompactionController<Readonly<{ id: string; text: string }>, string>({
      applySnapshot: ({ snapshot }) => [{ id: 'summary', text: snapshot }],
      countInputTokens: async () => 85_000,
      createSnapshot: async ({ messages }) => messages.map((message) => message.text).join(' '),
      messagesEqual: (left, right) => left.id === right.id && left.text === right.text,
      policy,
      scheduleCompaction: async ({ run }) => {
        scheduledRuns.push(run);
      },
    });

    await controller.prepareMessages([{ id: 'a', text: 'old' }]);
    await controller.prepareMessages([{ id: 'a', text: 'new' }]);

    expect(scheduledRuns).toHaveLength(2);
    await expect(scheduledRuns[0]?.()).rejects.toBeInstanceOf(ConversationCompactionSupersededError);
    await expect(scheduledRuns[1]?.()).resolves.toBe('new');
  });

  it('allows proactive rescheduling after a background run fails', async () => {
    const scheduledRuns: Array<() => Promise<string>> = [];
    let attempts = 0;
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens: async () => 85_000,
      createSnapshot: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('TransientCompactionFailure');
        return 'summary';
      },
      policy,
      scheduleCompaction: async ({ run }) => {
        scheduledRuns.push(run);
      },
    });

    await controller.prepareMessages(['a']);
    await expect(scheduledRuns[0]?.()).rejects.toThrow('TransientCompactionFailure');
    expect(controller.pending()).toBe(false);

    await controller.prepareMessages(['a']);
    expect(scheduledRuns).toHaveLength(2);
    await expect(scheduledRuns[1]?.()).resolves.toBe('summary');
  });

  it('serializes overlapping preparation calls', async () => {
    let activeCounts = 0;
    let maximumActiveCounts = 0;
    const measured: string[][] = [];
    const controller = createConversationCompactionController<string, string>({
      applySnapshot: ({ snapshot }) => [snapshot],
      countInputTokens: async ({ messages }) => {
        activeCounts += 1;
        maximumActiveCounts = Math.max(maximumActiveCounts, activeCounts);
        measured.push([...messages]);
        await Promise.resolve();
        activeCounts -= 1;
        return 10;
      },
      createSnapshot: async () => 'summary',
      policy,
    });

    await Promise.all([controller.prepareMessages(['a']), controller.prepareMessages(['a', 'b'])]);

    expect(maximumActiveCounts).toBe(1);
    expect(measured).toEqual([['a'], ['a', 'b']]);
  });
});
