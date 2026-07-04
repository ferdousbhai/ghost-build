import { Chat } from './chat/Chat';
import { GhostbuildAuthProvider } from './chat/GhostbuildAuthWrapper';
import { useRef } from 'react';
import { useChatHomepage } from '~/lib/stores/startup';
import { Toaster } from '~/components/ui/Toaster';
import { setPageLoadChatId } from '~/lib/stores/chatId';
import type { PartCache } from '~/lib/hooks/useMessageParser';
import { UserProvider } from '~/components/UserProvider';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

let homepageInitialId: string | undefined;

function getHomepageInitialId() {
  homepageInitialId ??= crypto.randomUUID();
  return homepageInitialId;
}

export function Homepage() {
  // Set up a temporary chat ID early in app initialization. We'll
  // eventually replace this with a slug once we receive the first
  // artifact from the model if the user submits a prompt.
  const initialId = getHomepageInitialId();
  setPageLoadChatId(initialId);
  // NB: On this path, we render `ChatImpl` immediately.
  return (
    <>
      <GhostbuildAuthProvider redirectIfUnauthenticated={false}>
        <UserProvider>
          <ChatWrapper initialId={initialId} />
        </UserProvider>
      </GhostbuildAuthProvider>
      <Toaster />
    </>
  );
}

const ChatWrapper = ({ initialId }: { initialId: string }) => {
  const partCache = useRef<PartCache>(new Map());
  const { storeMessageHistory, initializeChat, initialMessages, subchats } = useChatHomepage(initialId);
  return (
    <Chat
      initialMessages={initialMessages ?? emptyList}
      partCache={partCache.current}
      storeMessageHistory={storeMessageHistory}
      initializeChat={initializeChat}
      isReload={false}
      hadSuccessfulDeploy={false}
      subchats={subchats}
    />
  );
};

const emptyList: GhostbuildMessage[] = [];
