import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import {
  transcriptCheckpointMatchesMessages,
  transcriptCheckpointSchema,
  transcriptCheckpointsEqual,
  transcriptIdentitiesEqual,
  type TranscriptCheckpoint,
} from 'ghostbuild-agent/transcript';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { toast } from 'sonner';
import { cachePersistedTranscript } from '~/lib/cloudflare/chat-transcript-db';
import { compressWithLz4 } from '~/lib/compression';
import { buildUncompressedSnapshot } from '~/lib/snapshot.client';
import { getFileUpdateCounter, waitForFileUpdateCounterChanged } from '~/lib/stores/fileUpdateCounter';
import { subchatIndexStore, waitForSubchatIndexChanged } from '~/lib/stores/subchats';
import { waitForStoreValue } from '~/lib/stores/waitForStore';
import { backoffTime } from '~/utils/constants';
import { chatSyncState, type BackupSyncState, type InitialBackupSyncState } from './chatSyncState';
import { isCompleteMessageInfoAtLeast } from './backup-sync-policy';
import {
  type CompleteMessageInfo,
  lastCompleteMessageInfoStore,
  prepareMessageHistory,
  waitForNewMessages,
} from './messages';

const logger = createScopedLogger('backup-sync-worker');
const BACKUP_DEBOUNCE_MS = 1000;

interface ChatSyncWorkerOptions {
  chatId: string;
  sessionId: string;
  currentSubchatIndex: number | undefined;
  latestSubchatIndex: number | undefined;
  abortSignal?: AbortSignal;
}

let activeWorker: { token: symbol; signal: AbortSignal } | null = null;

export function initializeBackupPosition(
  chatId: string,
  initialMessages: GhostbuildMessage[],
  loadedSubchatIndex: number,
  checkpoint: TranscriptCheckpoint | null = null,
): void {
  const lastMessage = initialMessages[initialMessages.length - 1];
  const initialMessageInfo = {
    messageIndex: initialMessages.length - 1,
    partIndex: (lastMessage?.parts?.length ?? 0) - 1,
  };
  const currentState = chatSyncState.get();
  const chatChanged = currentState.chatId !== chatId;
  if (!chatChanged && currentState.persistedMessageInfo !== null && loadedSubchatIndex === currentState.subchatIndex) {
    return;
  }
  chatSyncState.set({
    ...currentState,
    chatId,
    ...(chatChanged
      ? {
          lastSync: 0,
          numFailures: 0,
          savedFileUpdateCounter: null,
          started: false,
          persistedTranscriptCheckpoint: null,
        }
      : {}),
    persistedMessageInfo: initialMessageInfo,
    persistedTranscriptCheckpoint: checkpoint,
    subchatIndex: loadedSubchatIndex,
  });
  const currentCompleteInfo = lastCompleteMessageInfoStore.get();
  if (chatChanged || !isCompleteMessageInfoAtLeast(currentCompleteInfo, initialMessageInfo)) {
    lastCompleteMessageInfoStore.set({
      ...initialMessageInfo,
      allMessages: initialMessages,
      hasNextPart: false,
      transcriptCheckpoint: checkpoint,
    });
  }
}

export function hasPendingBackupWork(
  currentState: BackupSyncState,
  completeMessageInfo: CompleteMessageInfo | null,
  fileUpdateCounter: number,
): boolean {
  return (
    hasPendingMessageBackup(currentState, completeMessageInfo) ||
    (completeMessageInfo?.transcriptCheckpoint !== null &&
      completeMessageInfo?.transcriptCheckpoint !== undefined &&
      currentState.savedFileUpdateCounter !== null &&
      currentState.savedFileUpdateCounter !== fileUpdateCounter)
  );
}

export async function chatSyncWorker(options: ChatSyncWorkerOptions): Promise<void> {
  if (
    options.currentSubchatIndex === undefined ||
    options.latestSubchatIndex === undefined ||
    options.currentSubchatIndex !== options.latestSubchatIndex
  ) {
    return;
  }
  if (activeWorker && !activeWorker.signal.aborted) {
    return;
  }

  const signal = options.abortSignal ?? new AbortController().signal;
  signal.throwIfAborted();
  const workerToken = Symbol('chat-sync-worker');
  activeWorker = { token: workerToken, signal };

  try {
    const initialState = await waitForInitialized(options.chatId, signal);
    chatSyncState.set({ ...initialState, started: true, subchatIndex: options.currentSubchatIndex });
    while (true) {
      const state = await waitForInitialized(options.chatId, signal);
      const completeMessageInfo = lastCompleteMessageInfoStore.get();
      if (completeMessageInfo === null) {
        logger.error('Complete message info not initialized');
        continue;
      }
      if (completeMessageInfo.messageIndex < 0 || completeMessageInfo.partIndex < 0) {
        await waitForNextSyncTrigger(state, completeMessageInfo, signal);
        continue;
      }
      if (!hasPendingBackupWork(state, completeMessageInfo, getFileUpdateCounter())) {
        await waitForNextSyncTrigger(state, completeMessageInfo, signal);
        // Every wait invalidates the snapshots above. Restart the loop instead
        // of syncing with the state that existed before the trigger.
        continue;
      }

      await waitForBackupDebounce(state.lastSync, signal);
      const latestState = await waitForInitialized(options.chatId, signal);
      const latestCompleteMessageInfo = lastCompleteMessageInfoStore.get();
      if (
        latestCompleteMessageInfo === null ||
        !hasPendingBackupWork(latestState, latestCompleteMessageInfo, getFileUpdateCounter())
      ) {
        continue;
      }
      await syncBackup(options.chatId, options.sessionId, latestState, latestCompleteMessageInfo, signal);
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    if (activeWorker?.token === workerToken) {
      activeWorker = null;
      const state = chatSyncState.get();
      if (state.chatId === options.chatId) {
        chatSyncState.set({ ...state, started: false });
      }
    }
  }
}

function hasPendingMessageBackup(
  currentState: BackupSyncState,
  completeMessageInfo: CompleteMessageInfo | null,
): boolean {
  return (
    currentState.persistedMessageInfo !== null &&
    completeMessageInfo !== null &&
    (currentState.persistedMessageInfo.messageIndex !== completeMessageInfo.messageIndex ||
      currentState.persistedMessageInfo.partIndex !== completeMessageInfo.partIndex ||
      completeMessageInfo.hasNextPart ||
      !transcriptCheckpointsEqual(currentState.persistedTranscriptCheckpoint, completeMessageInfo.transcriptCheckpoint))
  );
}

async function syncBackup(
  chatId: string,
  sessionId: string,
  currentState: InitialBackupSyncState,
  completeMessageInfo: CompleteMessageInfo,
  signal: AbortSignal,
): Promise<void> {
  const { url, update } = prepareMessageHistory({
    chatId,
    sessionId,
    completeMessageInfo,
    persistedMessageInfo: currentState.persistedMessageInfo,
    persistedTranscriptCheckpoint: currentState.persistedTranscriptCheckpoint,
    subchatIndex: currentState.subchatIndex,
  });
  const nextSavedUpdateCounter = getFileUpdateCounter();
  const snapshot =
    currentState.savedFileUpdateCounter !== nextSavedUpdateCounter ? await prepareBackupSnapshot() : undefined;
  signal.throwIfAborted();

  if (!update?.compressed && !snapshot) {
    return;
  }
  if (currentState.chatId !== chatId || currentState.subchatIndex !== subchatIndexStore.get()) {
    const state = chatSyncState.get();
    if (state.chatId === chatId) {
      chatSyncState.set({ ...state, persistedMessageInfo: null });
    }
    return;
  }

  const formData = buildBackupFormData(update?.compressed, snapshot, update?.firstMessage);
  let response: Response | undefined;
  let requestError: Error | null = null;
  try {
    response = await fetch(url, { method: 'POST', body: formData, signal });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    requestError = error as Error;
  }
  if (requestError || (response && !response.ok)) {
    await handleSyncFailure(chatId, currentState.subchatIndex, response, requestError, signal);
    return;
  }
  const latestState = chatSyncState.get();
  if (latestState.chatId !== chatId || latestState.subchatIndex !== currentState.subchatIndex) {
    return;
  }
  if (latestState.numFailures >= 3) {
    toast.dismiss('chat-save-failure');
  }
  if (update && completeMessageInfo.transcriptCheckpoint) {
    cachePersistedTranscript({
      sessionId,
      chatId,
      subchatIndex: currentState.subchatIndex,
      messages: completeMessageInfo.allMessages,
      lastMessageRank: update.messageIndex,
      partIndex: update.partIndex,
      checkpoint: completeMessageInfo.transcriptCheckpoint,
    });
  }
  chatSyncState.set({
    ...latestState,
    lastSync: Date.now(),
    numFailures: 0,
    savedFileUpdateCounter: nextSavedUpdateCounter,
    ...(update ? { persistedMessageInfo: { messageIndex: update.messageIndex, partIndex: update.partIndex } } : {}),
    ...(completeMessageInfo.transcriptCheckpoint
      ? { persistedTranscriptCheckpoint: completeMessageInfo.transcriptCheckpoint }
      : {}),
  });
}

function buildBackupFormData(
  messages: Uint8Array | undefined,
  snapshot: Uint8Array | undefined,
  firstMessage: string | undefined,
): FormData {
  const formData = new FormData();
  if (messages) {
    formData.append('messages', blobFromBytes(messages));
  }
  if (snapshot) {
    formData.append('snapshot', blobFromBytes(snapshot));
  }
  if (firstMessage) {
    formData.append('firstMessage', firstMessage);
  }
  return formData;
}

async function handleSyncFailure(
  attemptedChatId: string,
  attemptedSubchatIndex: number,
  response: Response | undefined,
  requestError: Error | null,
  signal: AbortSignal,
): Promise<void> {
  const errorText = response ? await response.text() : (requestError?.message ?? 'Unknown error');
  signal.throwIfAborted();
  const currentState = chatSyncState.get();
  if (currentState.chatId !== attemptedChatId || currentState.subchatIndex !== attemptedSubchatIndex) {
    return;
  }
  if (
    response?.status === 409 &&
    (await adoptAdvancedTranscriptCheckpoint(errorText, attemptedChatId, attemptedSubchatIndex))
  ) {
    if (currentState.numFailures >= 3) {
      toast.dismiss('chat-save-failure');
    }
    chatSyncState.set({ ...currentState, numFailures: 0 });
    logger.info('Retrying chat backup with the latest durable transcript checkpoint');
    return;
  }
  const failures = currentState.numFailures + 1;
  chatSyncState.set({ ...currentState, numFailures: failures });
  if (failures >= 3) {
    toast.error('Your chat is having trouble saving and progress may be lost. Download your code to save it.', {
      id: 'chat-save-failure',
      duration: Number.POSITIVE_INFINITY,
    });
  }
  const delay = backoffTime(failures);
  logger.error(`Failed to save chat (num failures: ${failures}), sleeping for ${delay.toFixed(2)}ms`, errorText);
  await abortableDelay(delay, signal);
}

export async function adoptAdvancedTranscriptCheckpoint(
  responseBody: string,
  attemptedChatId: string,
  attemptedSubchatIndex: number,
): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(responseBody);
  } catch {
    return false;
  }
  const result = transcriptCheckpointSchema.safeParse(
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>).checkpoint : undefined,
  );
  const complete = lastCompleteMessageInfoStore.get();
  const state = chatSyncState.get();
  if (
    !result.success ||
    complete === null ||
    state.chatId !== attemptedChatId ||
    state.subchatIndex !== attemptedSubchatIndex ||
    (complete.transcriptCheckpoint !== null &&
      !transcriptIdentitiesEqual(complete.transcriptCheckpoint, result.data)) ||
    !(await transcriptCheckpointMatchesMessages(result.data, complete.allMessages))
  ) {
    return false;
  }
  lastCompleteMessageInfoStore.set({ ...complete, transcriptCheckpoint: result.data });
  return true;
}

async function waitForNextSyncTrigger(
  currentState: InitialBackupSyncState,
  completeMessageInfo: CompleteMessageInfo,
  signal: AbortSignal,
): Promise<void> {
  const triggerController = new AbortController();
  const abortTriggers = () => triggerController.abort(signal.reason);
  signal.addEventListener('abort', abortTriggers, { once: true });
  const triggers = [
    waitForNewMessages(
      currentState.persistedMessageInfo.messageIndex,
      currentState.persistedMessageInfo.partIndex,
      !completeMessageInfo.hasNextPart,
      triggerController.signal,
    ),
    waitForSubchatIndexChanged(currentState.subchatIndex, triggerController.signal),
  ];
  if (!completeMessageInfo.hasNextPart) {
    triggers.push(waitForFileUpdateCounterChanged(currentState.savedFileUpdateCounter, triggerController.signal));
  }
  try {
    await Promise.race(triggers);
  } finally {
    signal.removeEventListener('abort', abortTriggers);
    triggerController.abort();
  }
}

async function waitForBackupDebounce(lastSync: number, signal: AbortSignal): Promise<void> {
  const remaining = lastSync + BACKUP_DEBOUNCE_MS - Date.now();
  if (remaining > 0) {
    await abortableDelay(remaining, signal);
  }
}

function blobFromBytes(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer]);
}

function waitForInitialized(chatId: string, signal: AbortSignal): Promise<InitialBackupSyncState> {
  return waitForStoreValue(
    chatSyncState,
    (state) => {
      if (
        state.chatId !== chatId ||
        state.persistedMessageInfo === null ||
        state.savedFileUpdateCounter === null ||
        state.subchatIndex !== subchatIndexStore.get()
      ) {
        return null;
      }
      return {
        ...state,
        chatId,
        persistedMessageInfo: state.persistedMessageInfo,
        savedFileUpdateCounter: state.savedFileUpdateCounter,
      };
    },
    { signal },
  );
}

async function prepareBackupSnapshot(): Promise<Uint8Array> {
  return compressWithLz4(await buildUncompressedSnapshot());
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}
