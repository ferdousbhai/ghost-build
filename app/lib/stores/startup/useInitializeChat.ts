import { executeDataOperation } from '~/lib/cloudflare/client';
import { waitForSessionId } from '~/lib/stores/sessionId';
import { useCallback } from 'react';
import { api } from '~/lib/cloudflare/data-api';

export function useHomepageInitializeChat(chatId: string, setChatInitialized: (chatInitialized: boolean) => void) {
  return useCallback(async () => {
    const sessionId = await waitForSessionId('useInitializeChat');

    const result = await executeDataOperation(api.messages.initializeChat, {
      id: chatId,
      sessionId,
    });
    setChatInitialized(true);
    return result;
  }, [chatId, setChatInitialized]);
}

export function useExistingInitializeChat(chatId: string) {
  return useCallback(async () => {
    const sessionId = await waitForSessionId('useInitializeChat');
    return executeDataOperation(api.messages.initializeChat, {
      id: chatId,
      sessionId,
    });
  }, [chatId]);
}

export function useDiscardEmptyChat(chatId: string) {
  return useCallback(async () => {
    const sessionId = await waitForSessionId('useDiscardEmptyChat');
    await executeDataOperation(api.messages.discardEmptyChat, {
      id: chatId,
      sessionId,
    });
  }, [chatId]);
}
