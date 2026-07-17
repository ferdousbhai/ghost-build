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
import { subchatIndexStore } from '~/lib/stores/subchats';
import { useStore } from '@nanostores/react';
import { transcriptAgentName } from 'ghostbuild-agent/transcript';

const EMPTY_INITIAL_MESSAGES: GhostbuildMessage[] = [];

export function useChatHomepage(chatId: string) {
  const [chatInitialized, setChatInitialized] = useState(false);
  const initializeChat = useHomepageInitializeChat(chatId, setChatInitialized);
  const storeMessageHistory = useStoreMessageHistory();
  useNewChatContainerSetup(chatInitialized);
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

  return {
    initializeChat,
    storeMessageHistory,
    initialMessages: loaded?.deserialized ?? EMPTY_INITIAL_MESSAGES,
    subchats,
    transcript,
    seedTranscript: loaded?.seedTranscript ?? false,
  };
}

export function useExistingChat(chatId: string) {
  const initializeChat = useExistingInitializeChat(chatId);
  const initialMessages = useInitialMessages(chatId);
  useBackupSyncState(
    chatId,
    initialMessages?.loadedSubchatIndex,
    initialMessages?.deserialized,
    initialMessages?.checkpoint,
  );
  const storeMessageHistory = useStoreMessageHistory();
  useExistingChatContainerSetup(initialMessages?.loadedChatId);
  const subchats = useSubchats(chatId);

  return {
    initialMessages: initialMessages ? initialMessages.deserialized : initialMessages,
    initializeChat,
    storeMessageHistory,
    subchats,
    transcript: initialMessages?.transcript,
    seedTranscript: initialMessages?.seedTranscript ?? false,
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
