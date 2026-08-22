import { useStore } from '@nanostores/react';
import { useEffect } from 'react';
import { api } from '~/lib/cloudflare/data-api';
import { useQuery } from '~/lib/cloudflare/data-hooks';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { loadedSubchatIndexStore, subchatIndexStore } from '~/lib/stores/subchats';
import { workbenchStore } from '~/lib/stores/workbench.client';

export function useChatSelectionSync(chatId: string, loadedSubchatIndex?: number): void {
  const subchatIndex = useStore(subchatIndexStore);
  const userId = useUserIdOrNullOrLoading();
  const chatInfo = useQuery(api.messages.get, userId ? { id: chatId, sessionId: userId } : 'skip');

  useEffect(() => {
    if (loadedSubchatIndex === undefined) {
      return undefined;
    }
    loadedSubchatIndexStore.set(loadedSubchatIndex);
    if (subchatIndexStore.get() !== loadedSubchatIndex) {
      subchatIndexStore.set(loadedSubchatIndex);
    }
    return () => {
      if (loadedSubchatIndexStore.get() === loadedSubchatIndex) {
        loadedSubchatIndexStore.set(undefined);
      }
    };
  }, [loadedSubchatIndex]);

  useEffect(() => {
    if (chatInfo && chatInfo.subchatIndex > 0) {
      workbenchStore.showWorkbench.set(true);
    }
  }, [chatInfo, subchatIndex]);
}
