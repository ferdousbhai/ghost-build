import { useStore } from '@nanostores/react';
import { useEffect } from 'react';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { api } from '~/lib/cloudflare/data-api';
import { useQuery } from '~/lib/cloudflare/data-hooks';
import { useUserIdOrNullOrLoading, waitForUserId } from '~/lib/stores/userId';
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

  useEffect(() => {
    if (loadedSubchatIndex !== undefined && subchatIndexStore.get() !== loadedSubchatIndex) {
      subchatIndexStore.set(loadedSubchatIndex);
    }
    if (initialMessages !== undefined && loadedSubchatIndex !== undefined) {
      initializeCheckpointPosition(chatId, initialMessages, loadedSubchatIndex, checkpoint ?? null);
    }
  }, [chatId, checkpoint, initialMessages, loadedSubchatIndex]);

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
      const activeUserId = await waitForUserId('useChatCheckpointSync');
      controller.signal.throwIfAborted();
      if (chatInfo && chatInfo.subchatIndex > 0) {
        workbenchStore.showWorkbench.set(true);
      }
      await chatSyncWorker({
        chatId,
        sessionId: activeUserId,
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
  }, [chatId, subchatIndex, chatInfo, loadedSubchatIndex]);
}
