import { useStoreMessageHistory } from './useStoreMessageHistory';
import { useDiscardEmptyChat, useExistingInitializeChat, useHomepageInitializeChat } from './useInitializeChat';
import { useInitialMessages } from './useInitialMessages';
import { useExistingChatContainerSetup, useNewChatContainerSetup } from './useContainerSetup';
import { useBackupSyncState } from './history';
import { useCallback, useState } from 'react';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { useAllSubchats } from '~/lib/cloudflare/data-hooks';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { useStore } from '@nanostores/react';
import { transcriptAgentName } from 'ghostbuild-agent/transcript';
import { navigateToChat } from '~/lib/stores/chatId';

const EMPTY_INITIAL_MESSAGES: GhostbuildMessage[] = [];

export function useChatHomepage(chatId: string) {
  const [chatInitialized, setChatInitialized] = useState(false);
  const [containerSetupEnabled, setContainerSetupEnabled] = useState(false);
  const initializeChat = useHomepageInitializeChat(chatId, setChatInitialized);
  const discardEmptyChat = useDiscardEmptyChat(chatId);
  const storeMessageHistory = useStoreMessageHistory();
  useNewChatContainerSetup(containerSetupEnabled);
  const loaded = useInitialMessages(chatInitialized ? chatId : undefined);
  useBackupSyncState(
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
    navigateToChat(chatId);
    setContainerSetupEnabled(true);
  }, [chatId]);

  return {
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    storeMessageHistory,
    initialMessages: loaded?.deserialized ?? EMPTY_INITIAL_MESSAGES,
    subchats,
    transcript,
    seedTranscript: loaded?.seedTranscript ?? false,
  };
}

export function useExistingChat(chatId: string) {
  const [containerSetupEnabled, setContainerSetupEnabled] = useState(false);
  const initializeChat = useExistingInitializeChat(chatId);
  const discardEmptyChat = useDiscardEmptyChat(chatId);
  const initialMessages = useInitialMessages(chatId);
  useBackupSyncState(
    chatId,
    initialMessages?.loadedSubchatIndex,
    initialMessages?.deserialized,
    initialMessages?.checkpoint,
  );
  const storeMessageHistory = useStoreMessageHistory();
  const requiresInitialContainer = (initialMessages?.deserialized.length ?? 0) > 0;
  useExistingChatContainerSetup(
    requiresInitialContainer || containerSetupEnabled ? initialMessages?.loadedChatId : undefined,
  );
  const subchats = useSubchats(chatId);
  const onBuilderRequestStart = useCallback(() => setContainerSetupEnabled(true), []);

  return {
    initialMessages: initialMessages ? initialMessages.deserialized : initialMessages,
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    requiresInitialContainer,
    storeMessageHistory,
    subchats,
    transcript: initialMessages?.transcript,
    seedTranscript: initialMessages?.seedTranscript ?? false,
  };
}

function useSubchats(chatId: string, enabled = true) {
  const sessionId = useSessionIdOrNullOrLoading();
  return useAllSubchats(
    sessionId && enabled
      ? {
          chatId,
          sessionId,
        }
      : 'skip',
  );
}
