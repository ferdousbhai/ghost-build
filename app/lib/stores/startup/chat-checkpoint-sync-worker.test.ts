import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { advanceTranscriptCheckpoint } from 'ghostbuild-agent/transcript';
import { isCompleteMessageInfoAtLeast } from './chat-checkpoint-sync-policy';
import {
  adoptAdvancedTranscriptCheckpoint,
  chatSyncWorker,
  checkpointRetryDelay,
  initializeCheckpointPosition,
  isTranscriptAdvanceConflict,
} from './chat-checkpoint-sync-worker';
import { chatCheckpointSyncState } from './chatCheckpointSyncState';
import { lastCompleteMessageInfoStore } from './messages';
import { subchatIndexStore } from '~/lib/stores/subchats';

const { fetchUserRuntimeMock, toastErrorMock } = vi.hoisted(() => ({
  fetchUserRuntimeMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('~/lib/cloudflare/runtime-session', () => ({
  fetchUserRuntime: fetchUserRuntimeMock,
}));
vi.mock('sonner', () => ({
  toast: { dismiss: vi.fn(), error: toastErrorMock },
}));

function message(id: string, text: string): GhostbuildMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

beforeEach(() => {
  fetchUserRuntimeMock.mockReset();
  toastErrorMock.mockReset();
  chatCheckpointSyncState.set({
    accountId: null,
    chatId: null,
    lastSync: 0,
    numFailures: 0,
    started: false,
    persistedMessageInfo: null,
    persistedTranscriptCheckpoint: null,
    subchatIndex: 0,
  });
  lastCompleteMessageInfoStore.set(null);
  subchatIndexStore.set(0);
});

describe('isCompleteMessageInfoAtLeast', () => {
  it('compares message and part positions lexicographically', () => {
    expect(isCompleteMessageInfoAtLeast(null, { messageIndex: 0, partIndex: 0 })).toBe(false);
    expect(isCompleteMessageInfoAtLeast({ messageIndex: 2, partIndex: 0 }, { messageIndex: 1, partIndex: 4 })).toBe(
      true,
    );
    expect(isCompleteMessageInfoAtLeast({ messageIndex: 1, partIndex: 3 }, { messageIndex: 1, partIndex: 4 })).toBe(
      false,
    );
  });
});

describe('initializeCheckpointPosition', () => {
  it('resets message and file checkpoints when navigating to a different chat at the same subchat', () => {
    const firstChatMessages = [message('a-1', 'first'), message('a-2', 'second')];
    initializeCheckpointPosition('account-a', 'chat-a', firstChatMessages, 0);
    chatCheckpointSyncState.set({
      ...chatCheckpointSyncState.get(),
      lastSync: 123,
      numFailures: 2,
    });

    const secondChatMessages = [message('b-1', 'new chat')];
    initializeCheckpointPosition('account-a', 'chat-b', secondChatMessages, 0);

    expect(chatCheckpointSyncState.get()).toMatchObject({
      accountId: 'account-a',
      chatId: 'chat-b',
      lastSync: 0,
      numFailures: 0,
      persistedMessageInfo: { messageIndex: 0, partIndex: 0 },
      subchatIndex: 0,
    });
    expect(lastCompleteMessageInfoStore.get()).toEqual({
      accountId: 'account-a',
      chatId: 'chat-b',
      subchatIndex: 0,
      messageIndex: 0,
      partIndex: 0,
      allMessages: secondChatMessages,
      hasNextPart: false,
      transcriptCheckpoint: null,
    });
  });

  it('replaces complete history from another subchat even when its message position is later', () => {
    const oldSubchatMessages = [message('a-1', 'first'), message('a-2', 'second'), message('a-3', 'third')];
    initializeCheckpointPosition('account-a', 'chat-a', oldSubchatMessages, 0);

    const newSubchatMessages = [message('b-1', 'new subchat')];
    initializeCheckpointPosition('account-a', 'chat-a', newSubchatMessages, 1);

    expect(lastCompleteMessageInfoStore.get()).toMatchObject({
      accountId: 'account-a',
      chatId: 'chat-a',
      subchatIndex: 1,
      messageIndex: 0,
      partIndex: 0,
      allMessages: newSubchatMessages,
    });
  });

  it('preserves progressed checkpoints when the same chat and subchat reinitialize', () => {
    const initialMessages = [message('a-1', 'first')];
    initializeCheckpointPosition('account-a', 'chat-a', initialMessages, 0);
    chatCheckpointSyncState.set({
      ...chatCheckpointSyncState.get(),
      persistedMessageInfo: { messageIndex: 3, partIndex: 2 },
    });

    initializeCheckpointPosition('account-a', 'chat-a', initialMessages, 0);

    expect(chatCheckpointSyncState.get()).toMatchObject({
      chatId: 'chat-a',
      persistedMessageInfo: { messageIndex: 3, partIndex: 2 },
    });
  });

  it('restores missing complete message state when the same chat reinitializes', () => {
    const initialMessages = [message('a-1', 'first')];
    initializeCheckpointPosition('account-a', 'chat-a', initialMessages, 0);
    lastCompleteMessageInfoStore.set(null);

    initializeCheckpointPosition('account-a', 'chat-a', initialMessages, 0);

    expect(lastCompleteMessageInfoStore.get()).toEqual({
      accountId: 'account-a',
      chatId: 'chat-a',
      subchatIndex: 0,
      messageIndex: 0,
      partIndex: 0,
      allMessages: initialMessages,
      hasNextPart: false,
      transcriptCheckpoint: null,
    });
  });
});

describe('chatSyncWorker', () => {
  it('yields until complete message state is initialized', async () => {
    chatCheckpointSyncState.set({
      accountId: 'session-a',
      chatId: 'chat-a',
      lastSync: 0,
      numFailures: 0,
      started: false,
      persistedMessageInfo: { messageIndex: 0, partIndex: 0 },
      persistedTranscriptCheckpoint: null,
      subchatIndex: 0,
    });
    const controller = new AbortController();
    const worker = chatSyncWorker({
      chatId: 'chat-a',
      sessionId: 'session-a',
      currentSubchatIndex: 0,
      latestSubchatIndex: 0,
      abortSignal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chatCheckpointSyncState.get().started).toBe(true);

    controller.abort();
    await expect(worker).resolves.toBeUndefined();
  });

  it('waits when an unfinished next part follows the persisted checkpoint', async () => {
    const messages = [message('a-1', 'first')];
    chatCheckpointSyncState.set({
      accountId: 'session-a',
      chatId: 'chat-a',
      lastSync: 0,
      numFailures: 0,
      started: false,
      persistedMessageInfo: { messageIndex: 0, partIndex: 0 },
      persistedTranscriptCheckpoint: null,
      subchatIndex: 0,
    });
    lastCompleteMessageInfoStore.set({
      accountId: 'session-a',
      chatId: 'chat-a',
      subchatIndex: 0,
      messageIndex: 0,
      partIndex: 0,
      allMessages: messages,
      hasNextPart: true,
      transcriptCheckpoint: null,
    });
    const controller = new AbortController();
    const worker = chatSyncWorker({
      chatId: 'chat-a',
      sessionId: 'session-a',
      currentSubchatIndex: 0,
      latestSubchatIndex: 0,
      abortSignal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chatCheckpointSyncState.get().started).toBe(true);

    controller.abort();
    await expect(worker).resolves.toBeUndefined();
  });

  it('counts and escalates an unadoptable transcript-advance conflict as a normal failure', async () => {
    const messages = [message('a-1', 'first')];
    const checkpoint = await advanceTranscriptCheckpoint(
      null,
      { agentName: 'chat-a', generation: 0, subchatIndex: 0 },
      messages,
    );
    chatCheckpointSyncState.set({
      accountId: 'session-a',
      chatId: 'chat-a',
      lastSync: 0,
      numFailures: 2,
      started: false,
      persistedMessageInfo: { messageIndex: 0, partIndex: 0 },
      persistedTranscriptCheckpoint: null,
      subchatIndex: 0,
    });
    lastCompleteMessageInfoStore.set({
      accountId: 'session-a',
      chatId: 'chat-a',
      subchatIndex: 0,
      messageIndex: 0,
      partIndex: 0,
      allMessages: messages,
      hasNextPart: false,
      transcriptCheckpoint: checkpoint,
    });
    fetchUserRuntimeMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'The agent transcript advanced before this checkpoint was saved. Retry with the latest transcript.',
        }),
        { status: 409 },
      ),
    );
    const random = vi.spyOn(Math, 'random').mockReturnValue(1);
    const controller = new AbortController();
    const worker = chatSyncWorker({
      chatId: 'chat-a',
      sessionId: 'session-a',
      currentSubchatIndex: 0,
      latestSubchatIndex: 0,
      abortSignal: controller.signal,
    });

    try {
      await vi.waitFor(() => expect(chatCheckpointSyncState.get().numFailures).toBe(3));
      expect(fetchUserRuntimeMock).toHaveBeenCalledTimes(1);
      expect(random).toHaveBeenCalledOnce();
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Your chat is having trouble saving and progress may be lost. Download your code to save it.',
        expect.objectContaining({ id: 'chat-save-failure' }),
      );
    } finally {
      controller.abort();
      await expect(worker).resolves.toBeUndefined();
      random.mockRestore();
    }
  });
});

describe('adoptAdvancedTranscriptCheckpoint', () => {
  it('updates a stale client checkpoint when the durable transcript matches the complete messages', async () => {
    const messages = [message('a-1', 'first'), message('a-2', 'second')];
    const identity = { agentName: 'chat-a', generation: 0, subchatIndex: 0 };
    const stale = await advanceTranscriptCheckpoint(null, identity, messages.slice(0, 1));
    const current = await advanceTranscriptCheckpoint(stale, identity, messages);
    initializeCheckpointPosition('account-a', 'chat-a', messages, 0, stale);
    lastCompleteMessageInfoStore.set({
      accountId: 'account-a',
      chatId: 'chat-a',
      subchatIndex: 0,
      messageIndex: 1,
      partIndex: 0,
      allMessages: messages,
      hasNextPart: false,
      transcriptCheckpoint: stale,
    });

    await expect(
      adoptAdvancedTranscriptCheckpoint(JSON.stringify({ checkpoint: current }), 'account-a', 'chat-a', 0),
    ).resolves.toBe(true);
    expect(lastCompleteMessageInfoStore.get()?.transcriptCheckpoint).toEqual(current);
  });

  it('rejects malformed, cross-chat, and message-mismatched conflict checkpoints', async () => {
    const messages = [message('a-1', 'first')];
    const identity = { agentName: 'chat-a', generation: 0, subchatIndex: 0 };
    const checkpoint = await advanceTranscriptCheckpoint(null, identity, messages);
    initializeCheckpointPosition('account-a', 'chat-a', messages, 0, checkpoint);

    await expect(adoptAdvancedTranscriptCheckpoint('not json', 'account-a', 'chat-a', 0)).resolves.toBe(false);
    await expect(
      adoptAdvancedTranscriptCheckpoint(JSON.stringify({ checkpoint }), 'account-a', 'chat-b', 0),
    ).resolves.toBe(false);
    await expect(
      adoptAdvancedTranscriptCheckpoint(
        JSON.stringify({
          checkpoint: { ...checkpoint, digest: 'b'.repeat(64) },
        }),
        'account-a',
        'chat-a',
        0,
      ),
    ).resolves.toBe(false);
  });
});

describe('chat checkpoint retry policy', () => {
  it('treats only the expected transcript race as a transient conflict', () => {
    expect(
      isTranscriptAdvanceConflict(
        409,
        JSON.stringify({
          error: 'The agent transcript advanced before this checkpoint was saved. Retry with the latest transcript.',
        }),
      ),
    ).toBe(true);
    expect(isTranscriptAdvanceConflict(409, JSON.stringify({ error: 'Chat checkpoint persistence failed.' }))).toBe(
      false,
    );
    expect(isTranscriptAdvanceConflict(500, 'not json')).toBe(false);
  });

  it('honors bounded Retry-After guidance from the checkpoint endpoint', () => {
    expect(checkpointRetryDelay(new Response(null, { headers: { 'Retry-After': '12' } }), 3)).toBe(12_000);
    expect(checkpointRetryDelay(new Response(null, { headers: { 'Retry-After': '9999' } }), 3)).toBe(300_000);
    expect(checkpointRetryDelay(new Response(null, { headers: { 'Retry-After': 'soon' } }), 3)).toBeGreaterThanOrEqual(
      0,
    );
  });
});
