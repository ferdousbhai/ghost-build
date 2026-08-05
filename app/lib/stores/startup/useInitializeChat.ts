import { executeDataOperation } from '~/lib/cloudflare/client';
import { waitForUserId } from '~/lib/stores/userId';
import { useCallback } from 'react';
import { api } from '~/lib/cloudflare/data-api';

export function useHomepageInitializeChat(chatId: string, setChatInitialized: (chatInitialized: boolean) => void) {
  return useCallback(async () => {
    const userId = await waitForUserId('useInitializeChat');

    const result = await executeDataOperation(api.messages.initializeChat, {
      id: chatId,
      sessionId: userId,
    });
    setChatInitialized(true);
    return result;
  }, [chatId, setChatInitialized]);
}

export function useExistingInitializeChat(chatId: string) {
  return useCallback(async () => {
    const userId = await waitForUserId('useInitializeChat');
    return executeDataOperation(api.messages.initializeChat, {
      id: chatId,
      sessionId: userId,
    });
  }, [chatId]);
}

export function useDiscardEmptyChat(chatId: string) {
  return useCallback(async () => {
    const userId = await waitForUserId('useDiscardEmptyChat');
    await executeDataOperation(api.messages.discardEmptyChat, {
      id: chatId,
      sessionId: userId,
    });
  }, [chatId]);
}
