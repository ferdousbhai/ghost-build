import { useExistingChat } from '~/lib/stores/startup';
import { Chat } from './chat/Chat';
import { GhostbuildAuthProvider } from './chat/GhostbuildAuthWrapper';
import { setPageLoadChatId } from '~/lib/stores/chatId';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { Loading } from './Loading';
import { useReloadMessages } from '~/lib/stores/startup/reloadMessages';
import { UserProvider } from '~/components/UserProvider';
import { Toaster } from '~/components/ui/Toaster';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';
import { Button } from '@ui/Button';

export function ExistingChat({ chatId }: { chatId: string }) {
  // Fill in the chatID store from props early in app initialization. If this
  // chat ID ends up being invalid, we'll abandon the page and redirect to
  // the homepage.
  setPageLoadChatId(chatId);

  return (
    <>
      <GhostbuildAuthProvider>
        <UserProvider>
          <ExistingChatWrapper chatId={chatId} />
        </UserProvider>
      </GhostbuildAuthProvider>
      <Toaster />
    </>
  );
}

function ExistingChatWrapper({ chatId }: { chatId: string }) {
  const userId = useUserIdOrNullOrLoading();
  return <ExistingChatSessionView chatId={chatId} userId={userId} />;
}

export function ExistingChatSessionView({ chatId, userId }: { chatId: string; userId: string | null | undefined }) {
  if (userId === undefined) {
    return <Loading message="Checking your Cloudflare session…" />;
  }
  if (userId === null) {
    return (
      <CloudflareSignInPrompt
        title="Connect Cloudflare to open this project."
        description="Connect the Cloudflare account that owns this project."
      />
    );
  }

  return <AuthenticatedExistingChat chatId={chatId} />;
}

function AuthenticatedExistingChat({ chatId }: { chatId: string }) {
  const {
    initialMessages,
    storeMessageHistory,
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    subchats,
    transcript,
  } = useExistingChat(chatId);

  const reloadState = useReloadMessages(initialMessages ?? undefined);

  if (initialMessages === null) {
    return <NotFound />;
  }

  // Download the account-owned chat after the session gate above has passed.
  if (initialMessages === undefined) {
    return <Loading message="Loading project…" />;
  }
  if (!transcript) {
    return <Loading message="Loading project…" />;
  }
  // Once we have the chat messages, we can populate the workbench state.
  // Note that this doesn't actually run any actions.
  if (reloadState === undefined) {
    return <Loading message="Loading project…" />;
  }
  return (
    <Chat
      initialMessages={initialMessages}
      partCache={reloadState.partCache}
      storeMessageHistory={storeMessageHistory}
      initializeChat={initializeChat}
      discardEmptyChat={discardEmptyChat}
      onBuilderRequestStart={onBuilderRequestStart}
      subchats={subchats}
      transcript={transcript}
    />
  );
}

function NotFound() {
  return (
    <div className="flex h-full items-center justify-center p-5">
      <section className="app-card w-full max-w-xl p-6 text-center sm:p-8" aria-labelledby="project-not-found-heading">
        <p className="app-page-eyebrow">Project unavailable</p>
        <h1
          id="project-not-found-heading"
          className="mt-2 font-display text-4xl font-black tracking-tight text-content-primary"
        >
          This project could not be found.
        </h1>
        <p className="mx-auto mt-4 max-w-md text-balance text-content-secondary">
          It may have been deleted, or it may belong to a different Cloudflare account.
        </p>
        <Button href="/" className="mt-6">
          Start a new project
        </Button>
      </section>
    </div>
  );
}
