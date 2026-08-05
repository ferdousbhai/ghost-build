import { useStoreMessageHistory } from './useStoreMessageHistory';
import { useDiscardEmptyChat, useExistingInitializeChat, useHomepageInitializeChat } from './useInitializeChat';
import { useInitialMessages } from './useInitialMessages';
import { useChatCheckpointSync } from './history';
import { useCallback, useEffect, useState } from 'react';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { useAllSubchats } from '~/lib/cloudflare/data-hooks';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { useStore } from '@nanostores/react';
import { transcriptAgentName } from 'ghostbuild-agent/transcript';
import { useNavigateToChat } from '~/lib/stores/chatId';

const EMPTY_INITIAL_MESSAGES: GhostbuildMessage[] = [];

export function useChatHomepage(chatId: string) {
  const navigateToChat = useNavigateToChat();
  const [chatInitialized, setChatInitialized] = useState(false);
  const initializeChat = useHomepageInitializeChat(chatId, setChatInitialized);
  const discardEmptyChat = useDiscardEmptyChat(chatId);
  const storeMessageHistory = useStoreMessageHistory();
  const loaded = useInitialMessages(chatInitialized ? chatId : undefined);
  useChatCheckpointSync(
    chatId,
    loaded?.loadedSubchatIndex ?? (chatInitialized ? 0 : undefined),
    loaded?.deserialized ?? (chatInitialized ? EMPTY_INITIAL_MESSAGES : undefined),
    loaded?.checkpoint,
  );
  const subchats = useSubchats(chatId, chatInitialized);
  const subchatIndex = useStore(subchatIndexStore) ?? 0;
  const loadedTranscript = loaded?.loadedSubchatIndex === subchatIndex ? loaded.transcript : undefined;
  const transcript =
    loadedTranscript ??
    subchats?.find((subchat) => subchat.subchatIndex === subchatIndex)?.transcript ??
    ({ agentName: transcriptAgentName(chatId, subchatIndex, 0), generation: 0, subchatIndex } as const);
  const onBuilderRequestStart = useCallback(() => {
    void navigateToChat(chatId);
  }, [chatId, navigateToChat]);

  return {
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    storeMessageHistory,
    initialMessages: loaded?.deserialized ?? EMPTY_INITIAL_MESSAGES,
    subchats,
    transcript,
  };
}

export function useExistingChat(chatId: string) {
  const navigateToChat = useNavigateToChat();
  const initializeChat = useExistingInitializeChat(chatId);
  const discardEmptyChat = useDiscardEmptyChat(chatId);
  const initialMessages = useInitialMessages(chatId);
  useEffect(() => {
    if (initialMessages?.loadedChatId && initialMessages.loadedChatId !== chatId) {
      void navigateToChat(initialMessages.loadedChatId);
    }
  }, [chatId, initialMessages?.loadedChatId, navigateToChat]);
  useChatCheckpointSync(
    chatId,
    initialMessages?.loadedSubchatIndex,
    initialMessages?.deserialized,
    initialMessages?.checkpoint,
  );
  const storeMessageHistory = useStoreMessageHistory();
  const subchats = useSubchats(chatId);
  const onBuilderRequestStart = useCallback(() => undefined, []);

  return {
    initialMessages: initialMessages ? initialMessages.deserialized : initialMessages,
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    storeMessageHistory,
    subchats,
    transcript: initialMessages?.transcript,
  };
}

function useSubchats(chatId: string, enabled = true) {
  const userId = useUserIdOrNullOrLoading();
  return useAllSubchats(
    userId && enabled
      ? {
          chatId,
          sessionId: userId,
        }
      : 'skip',
  );
}
