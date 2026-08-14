import { useStoreMessageHistory } from './useStoreMessageHistory';
import { useDiscardEmptyChat, useExistingInitializeChat, useHomepageInitializeChat } from './useInitializeChat';
import { useInitialMessages, useInitialMessagesState } from './useInitialMessages';
import { useChatCheckpointSync } from './history';
import { useCallback, useEffect, useState } from 'react';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { useAllSubchatsState } from '~/lib/cloudflare/data-hooks';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { useStore } from '@nanostores/react';
import { transcriptAgentName } from 'ghostbuild-agent/transcript';
import { useNavigateToChat } from '~/lib/stores/chatId';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';

const EMPTY_INITIAL_MESSAGES: GhostbuildMessage[] = [];

export function useChatHomepage(chatId: string) {
  const navigateToChat = useNavigateToChat();
  const [chatInitialized, setChatInitialized] = useState(false);
  const initializeChat = useHomepageInitializeChat(chatId, setChatInitialized);
  const discardEmptyChat = useDiscardEmptyChat(chatId);
  const userId = useUserIdOrNullOrLoading();
  const storeMessageHistory = useStoreMessageHistory(chatId, userId);
  const loaded = useInitialMessages(chatInitialized ? chatId : undefined);
  useChatCheckpointSync(
    chatId,
    loaded?.loadedSubchatIndex ?? (chatInitialized ? 0 : undefined),
    loaded?.deserialized ?? (chatInitialized ? EMPTY_INITIAL_MESSAGES : undefined),
    loaded?.checkpoint,
  );
  const subchatState = useSubchats(chatId, chatInitialized);
  const subchats = subchatState.subchats;
  const subchatIndex = useStore(subchatIndexStore) ?? 0;
  const loadedTranscript = loaded?.loadedSubchatIndex === subchatIndex ? loaded.transcript : undefined;
  const transcript =
    loadedTranscript ??
    subchats?.find((subchat) => subchat.subchatIndex === subchatIndex)?.transcript ??
    ({ agentName: transcriptAgentName(chatId, subchatIndex, 0), generation: 0, subchatIndex } as const);
  const onBuilderRequestStart = useCallback(() => {
    toolActivityStore.handoffActiveTurn();
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
  const initialMessageState = useInitialMessagesState(chatId);
  const initialMessages = initialMessageState.initialMessages;
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
  const userId = useUserIdOrNullOrLoading();
  const storeMessageHistory = useStoreMessageHistory(chatId, userId);
  const subchatState = useSubchats(chatId);
  const subchats = subchatState.subchats;
  const onBuilderRequestStart = useCallback(() => undefined, []);

  return {
    initialMessages: initialMessages ? initialMessages.deserialized : initialMessages,
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    storeMessageHistory,
    subchats,
    transcript: initialMessages?.transcript,
    loadError: initialMessageState.error,
    retryLoad: initialMessageState.retry,
    subchatLoadError: subchatState.error,
    retrySubchats: subchatState.retry,
  };
}

function useSubchats(chatId: string, enabled = true) {
  const userId = useUserIdOrNullOrLoading();
  return useAllSubchatsState(
    userId && enabled
      ? {
          chatId,
          sessionId: userId,
        }
      : 'skip',
  );
}
