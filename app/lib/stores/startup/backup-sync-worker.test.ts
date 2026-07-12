import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { isCompleteMessageInfoAtLeast } from './backup-sync-policy';
import { initializeBackupPosition } from './backup-sync-worker';
import { chatSyncState } from './chatSyncState';
import { lastCompleteMessageInfoStore } from './messages';

vi.mock('~/lib/compression', () => ({ compressWithLz4: vi.fn() }));
vi.mock('~/lib/snapshot.client', () => ({ buildUncompressedSnapshot: vi.fn() }));

function message(id: string, text: string): GhostbuildMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

beforeEach(() => {
  chatSyncState.set({
    chatId: null,
    lastSync: 0,
    numFailures: 0,
    started: false,
    persistedMessageInfo: null,
    savedFileUpdateCounter: null,
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

describe('initializeBackupPosition', () => {
  it('resets message and file checkpoints when navigating to a different chat at the same subchat', () => {
    const firstChatMessages = [message('a-1', 'first'), message('a-2', 'second')];
    initializeBackupPosition('chat-a', firstChatMessages, 0);
    chatSyncState.set({
      ...chatSyncState.get(),
      lastSync: 123,
      numFailures: 2,
      savedFileUpdateCounter: 42,
    });

    const secondChatMessages = [message('b-1', 'new chat')];
    initializeBackupPosition('chat-b', secondChatMessages, 0);

    expect(chatSyncState.get()).toMatchObject({
      chatId: 'chat-b',
      lastSync: 0,
      numFailures: 0,
      persistedMessageInfo: { messageIndex: 0, partIndex: 0 },
      savedFileUpdateCounter: null,
      subchatIndex: 0,
    });
    expect(lastCompleteMessageInfoStore.get()).toEqual({
      messageIndex: 0,
      partIndex: 0,
      allMessages: secondChatMessages,
      hasNextPart: false,
    });
  });

  it('preserves progressed checkpoints when the same chat and subchat reinitialize', () => {
    const initialMessages = [message('a-1', 'first')];
    initializeBackupPosition('chat-a', initialMessages, 0);
    chatSyncState.set({
      ...chatSyncState.get(),
      persistedMessageInfo: { messageIndex: 3, partIndex: 2 },
      savedFileUpdateCounter: 7,
    });

    initializeBackupPosition('chat-a', initialMessages, 0);

    expect(chatSyncState.get()).toMatchObject({
      chatId: 'chat-a',
      persistedMessageInfo: { messageIndex: 3, partIndex: 2 },
      savedFileUpdateCounter: 7,
    });
  });
});
