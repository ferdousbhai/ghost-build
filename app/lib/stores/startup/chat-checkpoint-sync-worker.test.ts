import { beforeEach, describe, expect, it } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { advanceTranscriptCheckpoint } from 'ghostbuild-agent/transcript';
import { isCompleteMessageInfoAtLeast } from './chat-checkpoint-sync-policy';
import {
  adoptAdvancedTranscriptCheckpoint,
  checkpointRetryDelay,
  initializeCheckpointPosition,
  isTranscriptAdvanceConflict,
} from './chat-checkpoint-sync-worker';
import { chatCheckpointSyncState } from './chatCheckpointSyncState';
import { lastCompleteMessageInfoStore } from './messages';

function message(id: string, text: string): GhostbuildMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

beforeEach(() => {
  chatCheckpointSyncState.set({
    chatId: null,
    lastSync: 0,
    numFailures: 0,
    started: false,
    persistedMessageInfo: null,
    persistedTranscriptCheckpoint: null,
    subchatIndex: 0,
  });
  lastCompleteMessageInfoStore.set(null);
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
    initializeCheckpointPosition('chat-a', firstChatMessages, 0);
    chatCheckpointSyncState.set({
      ...chatCheckpointSyncState.get(),
      lastSync: 123,
      numFailures: 2,
    });

    const secondChatMessages = [message('b-1', 'new chat')];
    initializeCheckpointPosition('chat-b', secondChatMessages, 0);

    expect(chatCheckpointSyncState.get()).toMatchObject({
      chatId: 'chat-b',
      lastSync: 0,
      numFailures: 0,
      persistedMessageInfo: { messageIndex: 0, partIndex: 0 },
      subchatIndex: 0,
    });
    expect(lastCompleteMessageInfoStore.get()).toEqual({
      messageIndex: 0,
      partIndex: 0,
      allMessages: secondChatMessages,
      hasNextPart: false,
      transcriptCheckpoint: null,
    });
  });

  it('preserves progressed checkpoints when the same chat and subchat reinitialize', () => {
    const initialMessages = [message('a-1', 'first')];
    initializeCheckpointPosition('chat-a', initialMessages, 0);
    chatCheckpointSyncState.set({
      ...chatCheckpointSyncState.get(),
      persistedMessageInfo: { messageIndex: 3, partIndex: 2 },
    });

    initializeCheckpointPosition('chat-a', initialMessages, 0);

    expect(chatCheckpointSyncState.get()).toMatchObject({
      chatId: 'chat-a',
      persistedMessageInfo: { messageIndex: 3, partIndex: 2 },
    });
  });
});

describe('adoptAdvancedTranscriptCheckpoint', () => {
  it('updates a stale client checkpoint when the durable transcript matches the complete messages', async () => {
    const messages = [message('a-1', 'first'), message('a-2', 'second')];
    const identity = { agentName: 'chat-a', generation: 0, subchatIndex: 0 };
    const stale = await advanceTranscriptCheckpoint(null, identity, messages.slice(0, 1));
    const current = await advanceTranscriptCheckpoint(stale, identity, messages);
    initializeCheckpointPosition('chat-a', messages, 0, stale);
    lastCompleteMessageInfoStore.set({
      messageIndex: 1,
      partIndex: 0,
      allMessages: messages,
      hasNextPart: false,
      transcriptCheckpoint: stale,
    });

    await expect(adoptAdvancedTranscriptCheckpoint(JSON.stringify({ checkpoint: current }), 'chat-a', 0)).resolves.toBe(
      true,
    );
    expect(lastCompleteMessageInfoStore.get()?.transcriptCheckpoint).toEqual(current);
  });

  it('rejects malformed, cross-chat, and message-mismatched conflict checkpoints', async () => {
    const messages = [message('a-1', 'first')];
    const identity = { agentName: 'chat-a', generation: 0, subchatIndex: 0 };
    const checkpoint = await advanceTranscriptCheckpoint(null, identity, messages);
    initializeCheckpointPosition('chat-a', messages, 0, checkpoint);

    await expect(adoptAdvancedTranscriptCheckpoint('not json', 'chat-a', 0)).resolves.toBe(false);
    await expect(adoptAdvancedTranscriptCheckpoint(JSON.stringify({ checkpoint }), 'chat-b', 0)).resolves.toBe(false);
    await expect(
      adoptAdvancedTranscriptCheckpoint(
        JSON.stringify({
          checkpoint: { ...checkpoint, digest: 'b'.repeat(64) },
        }),
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
