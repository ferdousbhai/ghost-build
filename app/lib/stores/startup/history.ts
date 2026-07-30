import { useStore } from '@nanostores/react';
import { useEffect } from 'react';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { api } from '~/lib/cloudflare/data-api';
import { useQuery } from '~/lib/cloudflare/data-hooks';
import { useSessionIdOrNullOrLoading, waitForSessionId } from '~/lib/stores/sessionId';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { chatSyncWorker, hasPendingBackupWork, initializeBackupPosition } from './backup-sync-worker';
import { chatSyncState } from './chatSyncState';
import { lastCompleteMessageInfoStore } from './messages';
import type { TranscriptCheckpoint } from 'ghostbuild-agent/transcript';

const logger = createScopedLogger('BackupSyncState');

export function useBackupSyncState(
  chatId: string,
  loadedSubchatIndex?: number,
  initialMessages?: GhostbuildMessage[],
  checkpoint?: TranscriptCheckpoint | null,
): void {
  const subchatIndex = useStore(subchatIndexStore);
  const sessionId = useSessionIdOrNullOrLoading();
  const chatInfo = useQuery(api.messages.get, sessionId ? { id: chatId, sessionId } : 'skip');

  useEffect(() => {
    if (loadedSubchatIndex !== undefined && subchatIndexStore.get() !== loadedSubchatIndex) {
      subchatIndexStore.set(loadedSubchatIndex);
    }
    if (initialMessages !== undefined && loadedSubchatIndex !== undefined) {
      initializeBackupPosition(chatId, initialMessages, loadedSubchatIndex, checkpoint ?? null);
    }
  }, [chatId, checkpoint, initialMessages, loadedSubchatIndex]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (hasPendingBackupWork(chatSyncState.get(), lastCompleteMessageInfoStore.get())) {
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
      const activeSessionId = await waitForSessionId('useBackupSyncState');
      controller.signal.throwIfAborted();
      if (chatInfo && chatInfo.subchatIndex > 0) {
        workbenchStore.showWorkbench.set(true);
      }
      await chatSyncWorker({
        chatId,
        sessionId: activeSessionId,
        currentSubchatIndex: subchatIndex,
        latestSubchatIndex: chatInfo?.subchatIndex ?? loadedSubchatIndex,
        abortSignal: controller.signal,
      });
    };
    void startWorker().catch((error) => {
      if (!controller.signal.aborted) {
        logger.error('Backup worker stopped unexpectedly', error);
      }
    });
    return () => controller.abort();
  }, [chatId, subchatIndex, chatInfo, loadedSubchatIndex]);
}
