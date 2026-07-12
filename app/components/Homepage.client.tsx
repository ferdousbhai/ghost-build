import { lazy, Suspense, useCallback, useState } from 'react';
import { GhostbuildAuthProvider } from './chat/GhostbuildAuthWrapper';
import { HomeIntro } from './chat/HomeIntro.client';
import { Toaster } from '~/components/ui/Toaster';
import { getPageLoadChatId, setPageLoadChatId } from '~/lib/stores/chatId';
import { UserProvider } from '~/components/UserProvider';

const HomepageChat = lazy(() => import('./HomepageChat.client').then((module) => ({ default: module.HomepageChat })));

function getOrCreateHomepageInitialId() {
  const existingId = getPageLoadChatId();
  if (existingId) {
    return existingId;
  }

  const initialId = crypto.randomUUID();
  setPageLoadChatId(initialId);

  return initialId;
}

export function Homepage() {
  const initialId = getOrCreateHomepageInitialId();
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);
  const startChat = useCallback(async (prompt: string) => {
    setInitialPrompt(prompt);
    return true;
  }, []);

  const homeIntro = (
    <HomeIntro
      actionAlert={undefined}
      clearAlert={() => undefined}
      disabledReason={null}
      isStreaming={false}
      messagesLength={0}
      onSend={startChat}
      onStop={() => undefined}
      sendMessageInProgress={initialPrompt !== null}
    />
  );

  return (
    <>
      <GhostbuildAuthProvider redirectIfUnauthenticated={false} allowGuest>
        <UserProvider>
          {initialPrompt === null ? (
            homeIntro
          ) : (
            <Suspense fallback={homeIntro}>
              <HomepageChat initialId={initialId} initialPrompt={initialPrompt} />
            </Suspense>
          )}
        </UserProvider>
      </GhostbuildAuthProvider>
      <Toaster />
    </>
  );
}
