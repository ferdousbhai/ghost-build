// @vitest-environment jsdom

import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { TranscriptCheckpoint } from 'ghostbuild-agent/transcript';
import type { StoreMessageHistory } from '~/components/chat/chat-types';

const mocks = vi.hoisted(() => ({ digestTranscriptMessages: vi.fn() }));
vi.mock('ghostbuild-agent/transcript', () => ({ digestTranscriptMessages: mocks.digestTranscriptMessages }));
vi.mock('~/lib/cloudflare/data-hooks', () => ({ useQuery: () => undefined }));
vi.mock('~/lib/stores/userId', () => ({ useUserIdOrNullOrLoading: () => accountId }));
vi.mock('~/lib/stores/workbench.client', () => ({ workbenchStore: { showWorkbench: { set: vi.fn() } } }));
vi.mock('./chat-checkpoint-sync-worker', () => ({
  chatSyncWorker: vi.fn(() => new Promise<void>(() => undefined)),
  hasPendingCheckpointWork: vi.fn(() => false),
  initializeCheckpointPosition: vi.fn(),
}));

import { subchatIndexStore } from '~/lib/stores/subchats';
import { lastCompleteMessageInfoStore } from './messages';
import { chatCheckpointSyncState } from './chatCheckpointSyncState';
import { useChatCheckpointSync } from './history';
import { useStoreMessageHistory } from './useStoreMessageHistory';

let root: Root | undefined;
let storeMessageHistory: StoreMessageHistory;
let chatId = 'chat-1';
let accountId: string | null | undefined = 'account-1';
let committedScope: { completeAccountId: string | null; checkpointAccountId: string | null } | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.digestTranscriptMessages.mockReset();
  lastCompleteMessageInfoStore.set(null);
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
  subchatIndexStore.set(0);
  chatId = 'chat-1';
  accountId = 'account-1';
  committedScope = undefined;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  lastCompleteMessageInfoStore.set(null);
});

function Harness() {
  storeMessageHistory = useStoreMessageHistory(chatId, accountId);
  return null;
}

function CommittedScopeHarness({ scopeAccountId }: { scopeAccountId: string }) {
  useChatCheckpointSync(chatId);
  storeMessageHistory = useStoreMessageHistory(chatId, scopeAccountId);
  useLayoutEffect(() => {
    committedScope = {
      completeAccountId: lastCompleteMessageInfoStore.get()?.accountId ?? null,
      checkpointAccountId: chatCheckpointSyncState.get().accountId,
    };
  }, [scopeAccountId]);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function message(id: string): GhostbuildMessage {
  return { id, role: 'user', parts: [{ type: 'text', text: id }] };
}

function checkpoint(digest: string, revision: number): TranscriptCheckpoint {
  return {
    agentName: 'agent',
    generation: 0,
    subchatIndex: 0,
    digest,
    messageCount: 1,
    revision,
  };
}

describe('useStoreMessageHistory', () => {
  it('does not let an older digest completion roll back a newer snapshot', async () => {
    const olderDigest = deferred<string>();
    const newerDigest = deferred<string>();
    mocks.digestTranscriptMessages.mockReturnValueOnce(olderDigest.promise).mockReturnValueOnce(newerDigest.promise);
    await act(async () => root?.render(<Harness />));

    const olderMessages = [message('older')];
    const newerMessages = [message('newer')];
    const olderWrite = storeMessageHistory(olderMessages, 'ready', checkpoint('a'.repeat(64), 1));
    const newerWrite = storeMessageHistory(newerMessages, 'ready', checkpoint('b'.repeat(64), 2));

    newerDigest.resolve('b'.repeat(64));
    await newerWrite;
    olderDigest.resolve('a'.repeat(64));
    await olderWrite;

    expect(lastCompleteMessageInfoStore.get()?.allMessages).toBe(newerMessages);
    expect(lastCompleteMessageInfoStore.get()?.transcriptCheckpoint?.revision).toBe(2);
  });

  it('invalidates a pending digest when the chat scope changes', async () => {
    const oldDigest = deferred<string>();
    mocks.digestTranscriptMessages.mockReturnValueOnce(oldDigest.promise);
    await act(async () => root?.render(<Harness />));

    const oldMessages = [message('old-chat')];
    const oldWrite = storeMessageHistory(oldMessages, 'ready', checkpoint('a'.repeat(64), 1));
    chatId = 'chat-2';
    await act(async () => root?.render(<Harness />));

    oldDigest.resolve('a'.repeat(64));
    await oldWrite;

    expect(lastCompleteMessageInfoStore.get()).toBeNull();
  });

  it('invalidates staged history and checkpoint state during the committed account transition', async () => {
    mocks.digestTranscriptMessages.mockResolvedValueOnce('a'.repeat(64));
    await act(async () => root?.render(<CommittedScopeHarness scopeAccountId="account-1" />));

    await storeMessageHistory([message('old-account')], 'ready', checkpoint('a'.repeat(64), 1));
    chatCheckpointSyncState.set({
      ...chatCheckpointSyncState.get(),
      accountId: 'account-1',
      chatId: 'chat-1',
      persistedMessageInfo: { messageIndex: -1, partIndex: -1 },
    });

    accountId = 'account-2';
    await act(async () => root?.render(<CommittedScopeHarness scopeAccountId="account-2" />));

    expect(committedScope).toEqual({ completeAccountId: null, checkpointAccountId: null });
    expect(lastCompleteMessageInfoStore.get()).toBeNull();
    expect(chatCheckpointSyncState.get()).toMatchObject({ accountId: null, chatId: null, started: false });
  });

  it('invalidates a pending digest when the account changes for the same chat', async () => {
    const oldDigest = deferred<string>();
    mocks.digestTranscriptMessages.mockReturnValueOnce(oldDigest.promise);
    await act(async () => root?.render(<Harness />));

    const oldMessages = [message('old-account')];
    const oldWrite = storeMessageHistory(oldMessages, 'ready', checkpoint('a'.repeat(64), 1));
    accountId = 'account-2';
    await act(async () => root?.render(<Harness />));

    oldDigest.resolve('a'.repeat(64));
    await oldWrite;

    expect(lastCompleteMessageInfoStore.get()).toBeNull();
  });

  it('does not stage persistence without an account identity', async () => {
    accountId = undefined;
    await act(async () => root?.render(<Harness />));

    await storeMessageHistory([message('unscoped')], 'ready', checkpoint('a'.repeat(64), 1));

    expect(mocks.digestTranscriptMessages).not.toHaveBeenCalled();
    expect(lastCompleteMessageInfoStore.get()).toBeNull();
  });
});
