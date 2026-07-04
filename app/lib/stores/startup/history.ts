import { useQuery } from '~/lib/cloudflare/data-hooks';
import { useSessionIdOrNullOrLoading, waitForSessionId } from '~/lib/stores/sessionId';
import { getFileUpdateCounter, waitForFileUpdateCounterChanged } from '~/lib/stores/fileUpdateCounter';
import { buildUncompressedSnapshot } from '~/lib/snapshot.client';
import { backoffTime } from '~/utils/constants';
import { useEffect } from 'react';
import { compressWithLz4 } from '~/lib/compression';
import {
  type CompleteMessageInfo,
  handleUrlHintAndDescription,
  lastCompleteMessageInfoStore,
  prepareMessageHistory,
  waitForNewMessages,
} from './messages';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { useStore } from '@nanostores/react';
import { subchatIndexStore, waitForSubchatIndexChanged } from '~/lib/stores/subchats';
import { api } from '~/lib/cloudflare/data-api';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { chatSyncState, type BackupSyncState, type InitialBackupSyncState } from './chatSyncState';
import { toast } from 'sonner';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { waitForStoreValue } from '~/lib/stores/waitForStore';

const logger = createScopedLogger('history');

const BACKUP_DEBOUNCE_MS = 1000;

export function useBackupSyncState(chatId: string, loadedSubchatIndex?: number, initialMessages?: GhostbuildMessage[]) {
  const subchatIndex = useStore(subchatIndexStore);
  const sessionId = useSessionIdOrNullOrLoading();
  const chatInfo = useQuery(
    api.messages.get,
    sessionId
      ? {
          id: chatId,
          sessionId,
        }
      : 'skip',
  );
  useEffect(() => {
    if (initialMessages !== undefined) {
      const lastMessage = initialMessages[initialMessages.length - 1];
      const lastMessagePartIndex = (lastMessage?.parts?.length ?? 0) - 1;
      const currentSyncState = chatSyncState.get();
      // Update the persistedMessageInfo when initialMessages is null or the subchat index changes
      if (
        loadedSubchatIndex !== undefined &&
        (currentSyncState.persistedMessageInfo === null || loadedSubchatIndex !== currentSyncState.subchatIndex)
      ) {
        chatSyncState.set({
          ...currentSyncState,
          persistedMessageInfo: {
            messageIndex: initialMessages.length - 1,
            partIndex: lastMessagePartIndex,
          },
          subchatIndex: loadedSubchatIndex,
        });
        lastCompleteMessageInfoStore.set({
          messageIndex: initialMessages.length - 1,
          partIndex: lastMessagePartIndex,
          allMessages: initialMessages,
          hasNextPart: false,
        });
      }
    }
  }, [initialMessages, loadedSubchatIndex]);
  useEffect(() => {
    const beforeUnloadHandler = (e: BeforeUnloadEvent) => {
      if (hasPendingBackupWork(chatSyncState.get(), lastCompleteMessageInfoStore.get(), getFileUpdateCounter())) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
      return undefined;
    };
    window.addEventListener('beforeunload', beforeUnloadHandler);
    return () => {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
    };
  }, []);
  useEffect(() => {
    const run = async () => {
      const sessionId = await waitForSessionId('useBackupSyncState');
      // Open the workbench by default if you have more than one subchat
      if (chatInfo && chatInfo.subchatIndex > 0) {
        workbenchStore.showWorkbench.set(true);
      }
      void chatSyncWorker({
        chatId,
        sessionId,
        currentSubchatIndex: subchatIndex,
        latestSubchatIndex: chatInfo?.subchatIndex,
      });
    };
    void run();
  }, [chatId, subchatIndex, chatInfo]);
}

function hasPendingBackupWork(
  currentState: BackupSyncState,
  completeMessageInfo: CompleteMessageInfo | null,
  fileUpdateCounter: number,
) {
  return (
    hasPendingMessageBackup(currentState, completeMessageInfo) ||
    (currentState.savedFileUpdateCounter !== null && currentState.savedFileUpdateCounter !== fileUpdateCounter)
  );
}

function hasPendingMessageBackup(currentState: BackupSyncState, completeMessageInfo: CompleteMessageInfo | null) {
  return (
    currentState.persistedMessageInfo !== null &&
    completeMessageInfo !== null &&
    (currentState.persistedMessageInfo.messageIndex !== completeMessageInfo.messageIndex ||
      currentState.persistedMessageInfo.partIndex !== completeMessageInfo.partIndex ||
      completeMessageInfo.hasNextPart)
  );
}

/**
 * This worker handles syncing both the chat history + the snapshot of the filesystem
 * state to the server.
 *
 * It holds the state of what it's synced so far in `chatSyncState` and listens for
 * changes to `lastCompleteMessageInfoStore` and `fileUpdateCounter` respectively
 * to know when to sync.
 */
async function chatSyncWorker(args: {
  chatId: string;
  sessionId: string;
  currentSubchatIndex: number | undefined;
  latestSubchatIndex: number | undefined;
}) {
  const { chatId, sessionId } = args;
  const currentState = chatSyncState.get();
  if (currentState.started) {
    return;
  }
  if (args.currentSubchatIndex === undefined || args.latestSubchatIndex === undefined) {
    return;
  }
  // We only need to sync if we're on the latest subchat. Otherwise, we shouldn't be sending
  // updates to the server.
  if (args.currentSubchatIndex !== args.latestSubchatIndex) {
    return;
  }
  chatSyncState.set({
    ...currentState,
    started: true,
    subchatIndex: args.currentSubchatIndex,
  });
  while (true) {
    const currentState = await waitForInitialized();
    const completeMessageInfo = lastCompleteMessageInfoStore.get();
    if (completeMessageInfo === null) {
      logger.error('Complete message info not initialized');
      continue;
    }
    const areMessagesUpToDate =
      completeMessageInfo.partIndex === currentState.persistedMessageInfo.partIndex &&
      completeMessageInfo.messageIndex === currentState.persistedMessageInfo.messageIndex;

    if (areMessagesUpToDate) {
      await waitForNextSyncTrigger(currentState, completeMessageInfo);
    }

    const nextSync = currentState.lastSync + BACKUP_DEBOUNCE_MS;
    const now = Date.now();
    if (now < nextSync) {
      await new Promise((resolve) => setTimeout(resolve, nextSync - now));
    }
    const { url, update } = prepareMessageHistory({
      chatId,
      sessionId,
      completeMessageInfo,
      persistedMessageInfo: currentState.persistedMessageInfo,
      subchatIndex: currentState.subchatIndex,
    });
    const messageBlob = update?.compressed;
    const urlHintAndDescription = update?.urlHintAndDescription;
    const firstMessage = update?.firstMessage;

    const nextSavedUpdateCounter = getFileUpdateCounter();
    const snapshotBlob =
      currentState.savedFileUpdateCounter !== nextSavedUpdateCounter ? await prepareBackup() : undefined;
    if (urlHintAndDescription !== undefined) {
      await handleUrlHintAndDescription(
        chatId,
        sessionId,
        urlHintAndDescription.urlHint,
        urlHintAndDescription.description,
      );
    }
    if (messageBlob === undefined && snapshotBlob === undefined) {
      continue;
    }
    let response;
    let error: Error | null = null;
    const formData = new FormData();
    if (messageBlob !== undefined) {
      formData.append('messages', blobFromBytes(messageBlob));
    }
    if (snapshotBlob !== undefined) {
      formData.append('snapshot', blobFromBytes(snapshotBlob));
    }
    if (firstMessage !== undefined) {
      formData.append('firstMessage', firstMessage);
    }
    if (currentState.subchatIndex !== subchatIndexStore.get()) {
      chatSyncState.set({
        ...currentState,
        persistedMessageInfo: null,
      });
      continue;
    }
    try {
      response = await fetch(url, {
        method: 'POST',
        body: formData,
      });
    } catch (e) {
      error = e as Error;
    }
    if (error !== null || (response !== undefined && !response.ok)) {
      const errorText = response !== undefined ? await response.text() : (error?.message ?? 'Unknown error');
      const newFailureCount = currentState.numFailures + 1;
      chatSyncState.set({
        ...currentState,
        numFailures: newFailureCount,
      });

      // Show toast notification after 3 consecutive failures
      if (newFailureCount >= 3) {
        toast.error('Your chat is having trouble saving and progress may be lost. Download your code to save it.', {
          id: 'chat-save-failure',
          duration: Number.POSITIVE_INFINITY,
        });
      }

      const sleepTime = backoffTime(newFailureCount);
      logger.error(
        `Failed to save chat (num failures: ${newFailureCount}), sleeping for ${sleepTime.toFixed(2)}ms`,
        errorText,
      );
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
      continue;
    }
    // Dismiss the save failure toast on successful save
    if (currentState.numFailures >= 3) {
      toast.dismiss('chat-save-failure');
    }

    const updates: Partial<BackupSyncState> = {
      lastSync: now,
      numFailures: 0,
      savedFileUpdateCounter: nextSavedUpdateCounter,
    };
    if (update !== null) {
      updates.persistedMessageInfo = { messageIndex: update.messageIndex, partIndex: update.partIndex };
    }
    chatSyncState.set({
      ...currentState,
      ...updates,
    });
  }
}

async function waitForNextSyncTrigger(currentState: InitialBackupSyncState, completeMessageInfo: CompleteMessageInfo) {
  const promises = [
    waitForNewMessages(
      currentState.persistedMessageInfo.messageIndex,
      currentState.persistedMessageInfo.partIndex,
      !completeMessageInfo.hasNextPart,
    ),
    waitForSubchatIndexChanged(currentState.subchatIndex),
  ];

  if (!completeMessageInfo.hasNextPart) {
    promises.push(waitForFileUpdateCounterChanged(currentState.savedFileUpdateCounter));
  }

  await Promise.race(promises);
}

function blobFromBytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer]);
}

function waitForInitialized(): Promise<InitialBackupSyncState> {
  return waitForStoreValue(chatSyncState, initializedBackupSyncState);
}

function initializedBackupSyncState(state: BackupSyncState): InitialBackupSyncState | null {
  if (
    state.persistedMessageInfo === null ||
    state.savedFileUpdateCounter === null ||
    state.subchatIndex !== subchatIndexStore.get()
  ) {
    return null;
  }

  return {
    ...state,
    persistedMessageInfo: state.persistedMessageInfo,
    savedFileUpdateCounter: state.savedFileUpdateCounter,
  };
}

async function prepareBackup() {
  const binarySnapshot = await buildUncompressedSnapshot();
  const compressed = await compressWithLz4(binarySnapshot);
  return compressed;
}
