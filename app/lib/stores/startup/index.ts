import { useStoreMessageHistory } from './useStoreMessageHistory';
import { useExistingInitializeChat, useHomepageInitializeChat } from './useInitializeChat';
import { useInitialMessages } from './useInitialMessages';
import { useExistingChatContainerSetup, useNewChatContainerSetup } from './useContainerSetup';
import { useBackupSyncState } from './history';
import { useState } from 'react';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { useQuery } from '~/lib/cloudflare/data-hooks';
import { api } from '~/lib/cloudflare/data-api';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

const EMPTY_INITIAL_MESSAGES: GhostbuildMessage[] = [];

export function useChatHomepage(chatId: string) {
  const [chatInitialized, setChatInitialized] = useState(false);
  const initializeChat = useHomepageInitializeChat(chatId, setChatInitialized);
  const storeMessageHistory = useStoreMessageHistory();
  useNewChatContainerSetup();
  useBackupSyncState(chatId, chatInitialized ? 0 : undefined, chatInitialized ? EMPTY_INITIAL_MESSAGES : undefined);
  const subchats = useSubchats(chatId, chatInitialized);

  return {
    initializeChat,
    storeMessageHistory,
    initialMessages: EMPTY_INITIAL_MESSAGES,
    subchats,
  };
}

export function useExistingChat(chatId: string) {
  const initializeChat = useExistingInitializeChat(chatId);
  const initialMessages = useInitialMessages(chatId);
  useBackupSyncState(chatId, initialMessages?.loadedSubchatIndex, initialMessages?.deserialized);
  const storeMessageHistory = useStoreMessageHistory();
  useExistingChatContainerSetup(initialMessages?.loadedChatId);
  const subchats = useSubchats(chatId);

  return {
    initialMessages: initialMessages ? initialMessages.deserialized : initialMessages,
    initializeChat,
    storeMessageHistory,
    subchats,
  };
}

function useSubchats(chatId: string, enabled = true) {
  const sessionId = useSessionIdOrNullOrLoading();
  return useQuery(
    api.subchats.get,
    sessionId && enabled
      ? {
          chatId,
          sessionId,
        }
      : 'skip',
  );
}
