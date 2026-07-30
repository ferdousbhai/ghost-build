import { useExistingChat } from '~/lib/stores/startup';
import { Chat } from './chat/Chat';
import { GhostbuildAuthProvider } from './chat/GhostbuildAuthWrapper';
import { setPageLoadChatId } from '~/lib/stores/chatId';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { Loading } from './Loading';
import { useReloadMessages } from '~/lib/stores/startup/reloadMessages';
import { UserProvider } from '~/components/UserProvider';
import { Toaster } from '~/components/ui/Toaster';
import { getToolInvocation } from 'ghostbuild-agent/ai-compat';

export function ExistingChat({ chatId }: { chatId: string }) {
  // Fill in the chatID store from props early in app initialization. If this
  // chat ID ends up being invalid, we'll abandon the page and redirect to
  // the homepage.
  setPageLoadChatId(chatId);

  return (
    <>
      <GhostbuildAuthProvider redirectIfUnauthenticated={false}>
        <UserProvider>
          <ExistingChatWrapper chatId={chatId} />
        </UserProvider>
      </GhostbuildAuthProvider>
      <Toaster />
    </>
  );
}

function ExistingChatWrapper({ chatId }: { chatId: string }) {
  const sessionId = useSessionIdOrNullOrLoading();
  const {
    initialMessages,
    storeMessageHistory,
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    subchats,
    transcript,
    seedTranscript,
  } = useExistingChat(chatId);

  const reloadState = useReloadMessages(initialMessages ?? undefined);

  if (initialMessages === null) {
    return <NotFound />;
  }

  // First, we need a Cloudflare-backed account session ID.
  if (!sessionId) {
    return <Loading message="Starting session..." />;
  }
  // Then, we need to download the chat messages from the server.
  if (initialMessages === undefined) {
    return <Loading message="Loading chat messages..." />;
  }
  if (!transcript) {
    return <Loading message="Loading transcript..." />;
  }
  // Once we have the chat messages, we can populate the workbench state.
  // Note that this doesn't actually run any actions.
  if (reloadState === undefined) {
    return <Loading message="Parsing chat messages..." />;
  }
  const hadSuccessfulDeploy = initialMessages.some(
    (message) =>
      message.role === 'assistant' && message.parts?.some((part) => getToolInvocation(part)?.toolName === 'deploy'),
  );

  return (
    <Chat
      initialMessages={initialMessages}
      partCache={reloadState.partCache}
      storeMessageHistory={storeMessageHistory}
      initializeChat={initializeChat}
      discardEmptyChat={discardEmptyChat}
      onBuilderRequestStart={onBuilderRequestStart}
      isReload={true}
      hadSuccessfulDeploy={hadSuccessfulDeploy}
      subchats={subchats}
      transcript={transcript}
      seedTranscript={seedTranscript}
    />
  );
}

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center">
      <h1 className="text-content-primary mb-4 font-display text-4xl font-bold tracking-tight">Not found</h1>
      <p className="text-content-secondary mb-4 text-balance">
        The Ghostbuild project you’re looking for can’t be found. Maybe it was deleted or created with another account?
      </p>
      <a
        href="/"
        className="inline-flex items-center gap-2 rounded-lg bg-bolt-elements-button-primary-background px-4 py-2 text-bolt-elements-button-primary-text transition-colors hover:bg-bolt-elements-button-primary-backgroundHover"
      >
        <span className="text-sm font-medium">Return home</span>
      </a>
    </div>
  );
}
