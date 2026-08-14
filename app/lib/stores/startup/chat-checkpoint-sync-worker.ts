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
import { subchatIndexStore, waitForSubchatIndexChanged } from '~/lib/stores/subchats';
import { waitForStoreValue } from '~/lib/stores/waitForStore';
import { backoffTime } from '~/utils/constants';
import {
  chatCheckpointSyncState,
  type ChatCheckpointSyncState,
  type InitializedChatCheckpointSyncState,
} from './chatCheckpointSyncState';
import { isCompleteMessageInfoAtLeast } from './chat-checkpoint-sync-policy';
import {
  type CompleteMessageInfo,
  lastCompleteMessageInfoStore,
  prepareMessageHistory,
  waitForNewMessages,
} from './messages';
import { fetchUserRuntime } from '~/lib/cloudflare/runtime-session';

const logger = createScopedLogger('chat-checkpoint-sync-worker');
const CHECKPOINT_DEBOUNCE_MS = 1000;
const TRANSCRIPT_ADVANCED_ERROR =
  'The agent transcript advanced before this checkpoint was saved. Retry with the latest transcript.';

interface ChatSyncWorkerOptions {
  chatId: string;
  sessionId: string;
  currentSubchatIndex: number | undefined;
  latestSubchatIndex: number | undefined;
  abortSignal?: AbortSignal;
}

let activeWorker: { token: symbol; signal: AbortSignal } | null = null;

export function initializeCheckpointPosition(
  accountId: string,
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
  const currentState = chatCheckpointSyncState.get();
  const scopeChanged = currentState.accountId !== accountId || currentState.chatId !== chatId;
  const storedCompleteInfo = lastCompleteMessageInfoStore.get();
  const currentCompleteInfo =
    storedCompleteInfo?.accountId === accountId &&
    storedCompleteInfo.chatId === chatId &&
    storedCompleteInfo.subchatIndex === loadedSubchatIndex
      ? storedCompleteInfo
      : null;
  if (!scopeChanged && currentState.persistedMessageInfo !== null && loadedSubchatIndex === currentState.subchatIndex) {
    if (
      currentCompleteInfo === null &&
      currentState.persistedMessageInfo.messageIndex === initialMessageInfo.messageIndex &&
      currentState.persistedMessageInfo.partIndex === initialMessageInfo.partIndex
    ) {
      lastCompleteMessageInfoStore.set({
        accountId,
        chatId,
        subchatIndex: loadedSubchatIndex,
        ...initialMessageInfo,
        allMessages: initialMessages,
        hasNextPart: false,
        transcriptCheckpoint: checkpoint,
      });
    }
    return;
  }
  chatCheckpointSyncState.set({
    ...currentState,
    accountId,
    chatId,
    ...(scopeChanged
      ? {
          lastSync: 0,
          numFailures: 0,
          started: false,
          persistedTranscriptCheckpoint: null,
        }
      : {}),
    persistedMessageInfo: initialMessageInfo,
    persistedTranscriptCheckpoint: checkpoint,
    subchatIndex: loadedSubchatIndex,
  });
  if (scopeChanged || !isCompleteMessageInfoAtLeast(currentCompleteInfo, initialMessageInfo)) {
    lastCompleteMessageInfoStore.set({
      accountId,
      chatId,
      subchatIndex: loadedSubchatIndex,
      ...initialMessageInfo,
      allMessages: initialMessages,
      hasNextPart: false,
      transcriptCheckpoint: checkpoint,
    });
  }
}

export function hasPendingCheckpointWork(
  currentState: ChatCheckpointSyncState,
  completeMessageInfo: CompleteMessageInfo | null,
): boolean {
  return hasPendingMessageCheckpoint(currentState, completeMessageInfo);
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
    const initialState = await waitForInitialized(options.sessionId, options.chatId, signal);
    chatCheckpointSyncState.set({ ...initialState, started: true, subchatIndex: options.currentSubchatIndex });
    while (true) {
      const state = await waitForInitialized(options.sessionId, options.chatId, signal);
      const completeMessageInfo = completeMessageInfoForScope(options.sessionId, options.chatId, state.subchatIndex);
      if (completeMessageInfo === null) {
        await waitForStoreValue(
          lastCompleteMessageInfoStore,
          (messageInfo) =>
            messageInfo?.accountId === options.sessionId &&
            messageInfo.chatId === options.chatId &&
            messageInfo.subchatIndex === state.subchatIndex
              ? messageInfo
              : null,
          { signal },
        );
        continue;
      }
      if (completeMessageInfo.messageIndex < 0 || completeMessageInfo.partIndex < 0) {
        await waitForNextSyncTrigger(state, completeMessageInfo, signal);
        continue;
      }
      if (!hasPendingCheckpointWork(state, completeMessageInfo)) {
        await waitForNextSyncTrigger(state, completeMessageInfo, signal);
        // Every wait invalidates the snapshots above. Restart the loop instead
        // of syncing with the state that existed before the trigger.
        continue;
      }

      await waitForCheckpointDebounce(state.lastSync, signal);
      const latestState = await waitForInitialized(options.sessionId, options.chatId, signal);
      const latestCompleteMessageInfo = completeMessageInfoForScope(
        options.sessionId,
        options.chatId,
        latestState.subchatIndex,
      );
      if (latestCompleteMessageInfo === null || !hasPendingCheckpointWork(latestState, latestCompleteMessageInfo)) {
        continue;
      }
      await syncCheckpoint(options.chatId, options.sessionId, latestState, latestCompleteMessageInfo, signal);
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    if (activeWorker?.token === workerToken) {
      activeWorker = null;
      const state = chatCheckpointSyncState.get();
      if (state.accountId === options.sessionId && state.chatId === options.chatId) {
        chatCheckpointSyncState.set({ ...state, started: false });
      }
    }
  }
}

function hasPendingMessageCheckpoint(
  currentState: ChatCheckpointSyncState,
  completeMessageInfo: CompleteMessageInfo | null,
): boolean {
  return (
    currentState.accountId !== null &&
    currentState.chatId !== null &&
    currentState.persistedMessageInfo !== null &&
    completeMessageInfo !== null &&
    completeMessageInfo.accountId === currentState.accountId &&
    completeMessageInfo.chatId === currentState.chatId &&
    completeMessageInfo.subchatIndex === currentState.subchatIndex &&
    (currentState.persistedMessageInfo.messageIndex !== completeMessageInfo.messageIndex ||
      currentState.persistedMessageInfo.partIndex !== completeMessageInfo.partIndex ||
      !transcriptCheckpointsEqual(currentState.persistedTranscriptCheckpoint, completeMessageInfo.transcriptCheckpoint))
  );
}

async function syncCheckpoint(
  chatId: string,
  sessionId: string,
  currentState: InitializedChatCheckpointSyncState,
  completeMessageInfo: CompleteMessageInfo,
  signal: AbortSignal,
): Promise<void> {
  const { searchParams, update } = prepareMessageHistory({
    chatId,
    sessionId,
    completeMessageInfo,
    persistedMessageInfo: currentState.persistedMessageInfo,
    persistedTranscriptCheckpoint: currentState.persistedTranscriptCheckpoint,
    subchatIndex: currentState.subchatIndex,
  });
  signal.throwIfAborted();

  if (!update) {
    return;
  }
  const stateBeforeRequest = chatCheckpointSyncState.get();
  if (
    currentState.accountId !== sessionId ||
    currentState.chatId !== chatId ||
    stateBeforeRequest.accountId !== sessionId ||
    stateBeforeRequest.chatId !== chatId ||
    stateBeforeRequest.subchatIndex !== currentState.subchatIndex ||
    currentState.subchatIndex !== subchatIndexStore.get()
  ) {
    if (stateBeforeRequest.accountId === sessionId && stateBeforeRequest.chatId === chatId) {
      chatCheckpointSyncState.set({ ...stateBeforeRequest, persistedMessageInfo: null });
    }
    return;
  }

  let response: Response | undefined;
  let requestError: Error | null = null;
  try {
    response = await fetchUserRuntime(`/v1/chats/store?${searchParams}`, { method: 'POST', signal });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    requestError = error as Error;
  }
  if (requestError || (response && !response.ok)) {
    await handleSyncFailure(sessionId, chatId, currentState.subchatIndex, response, requestError, signal);
    return;
  }
  const latestState = chatCheckpointSyncState.get();
  if (
    latestState.accountId !== sessionId ||
    latestState.chatId !== chatId ||
    latestState.subchatIndex !== currentState.subchatIndex
  ) {
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
  chatCheckpointSyncState.set({
    ...latestState,
    lastSync: Date.now(),
    numFailures: 0,
    ...(update ? { persistedMessageInfo: { messageIndex: update.messageIndex, partIndex: update.partIndex } } : {}),
    ...(completeMessageInfo.transcriptCheckpoint
      ? { persistedTranscriptCheckpoint: completeMessageInfo.transcriptCheckpoint }
      : {}),
  });
}

async function handleSyncFailure(
  attemptedAccountId: string,
  attemptedChatId: string,
  attemptedSubchatIndex: number,
  response: Response | undefined,
  requestError: Error | null,
  signal: AbortSignal,
): Promise<void> {
  const errorText = response ? await response.text() : (requestError?.message ?? 'Unknown error');
  signal.throwIfAborted();
  const currentState = chatCheckpointSyncState.get();
  if (
    currentState.accountId !== attemptedAccountId ||
    currentState.chatId !== attemptedChatId ||
    currentState.subchatIndex !== attemptedSubchatIndex
  ) {
    return;
  }
  let failureState = currentState;
  if (isTranscriptAdvanceConflict(response?.status, errorText)) {
    const adopted = await adoptAdvancedTranscriptCheckpoint(
      errorText,
      attemptedAccountId,
      attemptedChatId,
      attemptedSubchatIndex,
    );
    signal.throwIfAborted();
    const latestState = chatCheckpointSyncState.get();
    if (
      latestState.accountId !== attemptedAccountId ||
      latestState.chatId !== attemptedChatId ||
      latestState.subchatIndex !== attemptedSubchatIndex
    ) {
      return;
    }
    if (adopted) {
      if (latestState.numFailures >= 3) {
        toast.dismiss('chat-save-failure');
      }
      chatCheckpointSyncState.set({ ...latestState, numFailures: 0 });
      logger.info('Retrying chat checkpoint after adopting the advanced durable transcript', {
        attemptedAccountId,
        attemptedChatId,
        attemptedSubchatIndex,
      });
      await abortableDelay(CHECKPOINT_DEBOUNCE_MS, signal);
      return;
    }
    failureState = latestState;
  }
  const failures = failureState.numFailures + 1;
  chatCheckpointSyncState.set({ ...failureState, numFailures: failures });
  if (failures >= 3) {
    toast.error('Your chat is having trouble saving and progress may be lost. Download your code to save it.', {
      id: 'chat-save-failure',
      duration: Number.POSITIVE_INFINITY,
    });
  }
  const delay = checkpointRetryDelay(response, failures);
  logger.error('Failed to save chat checkpoint', {
    attemptedAccountId,
    attemptedChatId,
    attemptedSubchatIndex,
    failures,
    responseStatus: response?.status,
    retryDelayMs: delay,
    error: errorText,
  });
  await abortableDelay(delay, signal);
}

export function isTranscriptAdvanceConflict(status: number | undefined, responseBody: string): boolean {
  if (status !== 409) {
    return false;
  }
  try {
    const value = JSON.parse(responseBody) as unknown;
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<string, unknown>).error === TRANSCRIPT_ADVANCED_ERROR
    );
  } catch {
    return false;
  }
}

export function checkpointRetryDelay(response: Response | undefined, failures: number): number {
  const retryAfter = response?.headers.get('Retry-After');
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1_000, 5 * 60_000);
  }
  return backoffTime(failures);
}

export async function adoptAdvancedTranscriptCheckpoint(
  responseBody: string,
  attemptedAccountId: string,
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
  const state = chatCheckpointSyncState.get();
  if (
    !result.success ||
    complete === null ||
    complete.accountId !== attemptedAccountId ||
    complete.chatId !== attemptedChatId ||
    complete.subchatIndex !== attemptedSubchatIndex ||
    state.accountId !== attemptedAccountId ||
    state.chatId !== attemptedChatId ||
    state.subchatIndex !== attemptedSubchatIndex ||
    (complete.transcriptCheckpoint !== null &&
      !transcriptIdentitiesEqual(complete.transcriptCheckpoint, result.data)) ||
    !(await transcriptCheckpointMatchesMessages(result.data, complete.allMessages))
  ) {
    return false;
  }
  const latestComplete = lastCompleteMessageInfoStore.get();
  const latestState = chatCheckpointSyncState.get();
  if (
    latestComplete !== complete ||
    latestState.accountId !== attemptedAccountId ||
    latestState.chatId !== attemptedChatId ||
    latestState.subchatIndex !== attemptedSubchatIndex
  ) {
    return false;
  }
  lastCompleteMessageInfoStore.set({ ...complete, transcriptCheckpoint: result.data });
  return true;
}

async function waitForNextSyncTrigger(
  currentState: InitializedChatCheckpointSyncState,
  completeMessageInfo: CompleteMessageInfo,
  signal: AbortSignal,
): Promise<void> {
  const triggerController = new AbortController();
  const abortTriggers = () => triggerController.abort(signal.reason);
  signal.addEventListener('abort', abortTriggers, { once: true });
  const triggers = [
    waitForNewMessages(
      currentState.accountId,
      currentState.chatId,
      currentState.subchatIndex,
      currentState.persistedMessageInfo.messageIndex,
      currentState.persistedMessageInfo.partIndex,
      !completeMessageInfo.hasNextPart,
      triggerController.signal,
    ),
    waitForSubchatIndexChanged(currentState.subchatIndex, triggerController.signal),
  ];
  try {
    await Promise.race(triggers);
  } finally {
    signal.removeEventListener('abort', abortTriggers);
    triggerController.abort();
  }
}

async function waitForCheckpointDebounce(lastSync: number, signal: AbortSignal): Promise<void> {
  const remaining = lastSync + CHECKPOINT_DEBOUNCE_MS - Date.now();
  if (remaining > 0) {
    await abortableDelay(remaining, signal);
  }
}

function completeMessageInfoForScope(
  accountId: string,
  chatId: string,
  subchatIndex: number,
): CompleteMessageInfo | null {
  const completeMessageInfo = lastCompleteMessageInfoStore.get();
  return completeMessageInfo?.accountId === accountId &&
    completeMessageInfo.chatId === chatId &&
    completeMessageInfo.subchatIndex === subchatIndex
    ? completeMessageInfo
    : null;
}

function waitForInitialized(
  accountId: string,
  chatId: string,
  signal: AbortSignal,
): Promise<InitializedChatCheckpointSyncState> {
  return waitForStoreValue(
    chatCheckpointSyncState,
    (state) => {
      if (
        state.accountId !== accountId ||
        state.chatId !== chatId ||
        state.persistedMessageInfo === null ||
        state.subchatIndex !== subchatIndexStore.get()
      ) {
        return null;
      }
      return {
        ...state,
        accountId,
        chatId,
        persistedMessageInfo: state.persistedMessageInfo,
      };
    },
    { signal },
  );
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
