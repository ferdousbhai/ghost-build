import { useRef } from 'react';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { Chat } from './chat/Chat';
import type { PartCache } from '~/lib/hooks/useMessageParser';
import { useChatHomepage } from '~/lib/stores/startup';

const EMPTY_MESSAGES: GhostbuildMessage[] = [];

export function HomepageChat({ initialId, initialPrompt }: { initialId: string; initialPrompt: string }) {
  const partCache = useRef<PartCache>(new Map());
  const { storeMessageHistory, initializeChat, initialMessages, subchats, transcript, seedTranscript } =
    useChatHomepage(initialId);

  return (
    <Chat
      initialMessages={initialMessages ?? EMPTY_MESSAGES}
      partCache={partCache.current}
      storeMessageHistory={storeMessageHistory}
      initializeChat={initializeChat}
      isReload={false}
      hadSuccessfulDeploy={false}
      subchats={subchats}
      allowGuest
      initialPrompt={initialPrompt}
      transcript={transcript}
      seedTranscript={seedTranscript}
    />
  );
}
