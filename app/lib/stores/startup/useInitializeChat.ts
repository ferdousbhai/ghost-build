import { executeDataOperation } from '~/lib/cloudflare/client';
import { waitForSessionId } from '~/lib/stores/sessionId';
import { useCallback } from 'react';
import { api } from '~/lib/cloudflare/data-api';
import { useGhostbuildAuth } from '~/components/chat/GhostbuildAuthWrapper';
import { ContainerBootState, waitForBootStepCompleted } from '~/lib/stores/containerBootState';
import { signInWithGoogle } from '~/lib/auth-client';

export function useHomepageInitializeChat(chatId: string, setChatInitialized: (chatInitialized: boolean) => void) {
  const ghostbuildAuthState = useGhostbuildAuth();
  const isFullyLoggedIn = ghostbuildAuthState.kind === 'fullyLoggedIn';
  return useCallback(async () => {
    if (!isFullyLoggedIn) {
      void signInWithGoogle();
      return false;
    }
    const sessionId = await waitForSessionId('useInitializeChat');

    await executeDataOperation(api.messages.initializeChat, {
      id: chatId,
      sessionId,
    });
    setChatInitialized(true);

    // Wait for the WebContainer to have its snapshot loaded before sending a message.
    await waitForBootStepCompleted(ContainerBootState.LOADING_SNAPSHOT);
    return true;
  }, [chatId, isFullyLoggedIn, setChatInitialized]);
}

export function useExistingInitializeChat(chatId: string) {
  return useCallback(async () => {
    const sessionId = await waitForSessionId('useInitializeChat');
    await executeDataOperation(api.messages.initializeChat, {
      id: chatId,
      sessionId,
    });

    // We don't need to wait for container boot here since we don't mount
    // the UI until it's fully ready.
    return true;
  }, [chatId]);
}
