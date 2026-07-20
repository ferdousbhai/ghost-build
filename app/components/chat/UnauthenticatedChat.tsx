import { useStore } from '@nanostores/react';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { useSnapScroll } from '~/lib/hooks/useSnapScroll';
import { BaseChat } from './BaseChat.client';
import type { ChatProps } from './chat-types';
import { createTerminalInitializationOptions } from './terminal-initialization';

export function UnauthenticatedChat({
  initialMessages,
  isReload,
  hadSuccessfulDeploy,
  subchats,
  authLoading,
}: Pick<ChatProps, 'initialMessages' | 'isReload' | 'hadSuccessfulDeploy' | 'subchats'> & {
  authLoading: boolean;
}) {
  const hasMultipleSubchats = (subchats?.length ?? 0) > 1;
  const chatStarted = initialMessages.length > 0 || hasMultipleSubchats;
  const actionAlert = useStore(workbenchStore.alert);
  const { messageRef, scrollRef } = useSnapScroll();
  const terminalInitializationOptions = useMemo(
    () =>
      createTerminalInitializationOptions({
        isReload,
        shouldRunWorkerBuild: hadSuccessfulDeploy || hasMultipleSubchats,
      }),
    [isReload, hadSuccessfulDeploy, hasMultipleSubchats],
  );

  return (
    <BaseChat
      messageRef={messageRef}
      scrollRef={scrollRef}
      showChat
      chatStarted={chatStarted}
      onStop={() => undefined}
      streamStatus="ready"
      buildProgress={null}
      isRecovering={false}
      currentError={undefined}
      toolStatus={{}}
      messages={initialMessages}
      actionAlert={actionAlert}
      clearAlert={() => workbenchStore.clearAlert()}
      terminalInitializationOptions={terminalInitializationOptions}
      disabledReason={authLoading ? 'Loading account...' : null}
      sendMessageInProgress={false}
      subchats={subchats}
      onSend={async () => {
        toast.info('Connect Cloudflare to chat or build.');
        return false;
      }}
    />
  );
}
