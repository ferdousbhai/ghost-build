import { useStore } from '@nanostores/react';
import { useEffect, useLayoutEffect } from 'react';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { api } from '~/lib/cloudflare/data-api';
import { useQuery } from '~/lib/cloudflare/data-hooks';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { chatSyncWorker, hasPendingCheckpointWork, initializeCheckpointPosition } from './chat-checkpoint-sync-worker';
import { chatCheckpointSyncState } from './chatCheckpointSyncState';
import { lastCompleteMessageInfoStore } from './messages';
import type { TranscriptCheckpoint } from 'ghostbuild-agent/transcript';

const logger = createScopedLogger('ChatCheckpointSyncState');

export function useChatCheckpointSync(
  chatId: string,
  loadedSubchatIndex?: number,
  initialMessages?: GhostbuildMessage[],
  checkpoint?: TranscriptCheckpoint | null,
): void {
  const subchatIndex = useStore(subchatIndexStore);
  const userId = useUserIdOrNullOrLoading();
  const chatInfo = useQuery(api.messages.get, userId ? { id: chatId, sessionId: userId } : 'skip');

  useLayoutEffect(
    () => () => {
      const state = chatCheckpointSyncState.get();
      if (state.accountId === userId && state.chatId === chatId) {
        chatCheckpointSyncState.set({ ...state, accountId: null, chatId: null, started: false });
      }
    },
    [chatId, userId],
  );

  useEffect(() => {
    if (loadedSubchatIndex !== undefined && subchatIndexStore.get() !== loadedSubchatIndex) {
      subchatIndexStore.set(loadedSubchatIndex);
    }
    if (userId && initialMessages !== undefined && loadedSubchatIndex !== undefined) {
      initializeCheckpointPosition(userId, chatId, initialMessages, loadedSubchatIndex, checkpoint ?? null);
    }
  }, [chatId, checkpoint, initialMessages, loadedSubchatIndex, userId]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (hasPendingCheckpointWork(chatCheckpointSyncState.get(), lastCompleteMessageInfoStore.get())) {
        event.preventDefault();
        event.returnValue = '';
        return '';
      }
      return undefined;
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const startWorker = async () => {
      if (!userId) {
        return;
      }
      if (chatInfo && chatInfo.subchatIndex > 0) {
        workbenchStore.showWorkbench.set(true);
      }
      await chatSyncWorker({
        chatId,
        sessionId: userId,
        currentSubchatIndex: subchatIndex,
        latestSubchatIndex: chatInfo?.subchatIndex ?? loadedSubchatIndex,
        abortSignal: controller.signal,
      });
    };
    void startWorker().catch((error) => {
      if (!controller.signal.aborted) {
        logger.error('Chat checkpoint worker stopped unexpectedly', error);
      }
    });
    return () => controller.abort();
  }, [chatId, subchatIndex, chatInfo, loadedSubchatIndex, userId]);
}
