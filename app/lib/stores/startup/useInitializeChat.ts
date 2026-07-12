import { executeDataOperation } from '~/lib/cloudflare/client';
import { waitForSessionId } from '~/lib/stores/sessionId';
import { useCallback } from 'react';
import { api } from '~/lib/cloudflare/data-api';

export function useHomepageInitializeChat(chatId: string, setChatInitialized: (chatInitialized: boolean) => void) {
  return useCallback(async () => {
    const sessionId = await waitForSessionId('useInitializeChat');

    await executeDataOperation(api.messages.initializeChat, {
      id: chatId,
      sessionId,
    });
    setChatInitialized(true);
    return true;
  }, [chatId, setChatInitialized]);
}

export function useExistingInitializeChat(chatId: string) {
  return useCallback(async () => {
    const sessionId = await waitForSessionId('useInitializeChat');
    await executeDataOperation(api.messages.initializeChat, {
      id: chatId,
      sessionId,
    });

    // We don't need to wait for container boot here since we don't mount
    // the UI until it's fully ready.
    return true;
  }, [chatId]);
}
