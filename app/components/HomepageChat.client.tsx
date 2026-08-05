import { useRef } from 'react';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { Chat } from './chat/Chat';
import type { PartCache } from '~/lib/hooks/useProcessedMessages';
import { useChatHomepage } from '~/lib/stores/startup';

const EMPTY_MESSAGES: GhostbuildMessage[] = [];

export function HomepageChat({ initialId, initialPrompt }: { initialId: string; initialPrompt: string }) {
  const partCache = useRef<PartCache>(new Map());
  const {
    storeMessageHistory,
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    initialMessages,
    subchats,
    transcript,
  } = useChatHomepage(initialId);

  return (
    <Chat
      initialMessages={initialMessages ?? EMPTY_MESSAGES}
      partCache={partCache.current}
      storeMessageHistory={storeMessageHistory}
      initializeChat={initializeChat}
      discardEmptyChat={discardEmptyChat}
      onBuilderRequestStart={onBuilderRequestStart}
      isReload={false}
      hadSuccessfulDeploy={false}
      subchats={subchats}
      initialPrompt={initialPrompt}
      transcript={transcript}
    />
  );
}
