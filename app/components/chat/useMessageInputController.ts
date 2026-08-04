import { useStore } from '@nanostores/react';
import { useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type ChangeEventHandler, type KeyboardEventHandler } from 'react';
import { toast } from 'sonner';
import { WORKERS_PAID_REQUIRED_MARKER } from '~/lib/workers-paid';
import { showWorkersPaidRequiredToast } from '~/lib/workers-paid.client';
import { captureException } from '~/lib/telemetry.client';
import { fetchUserRuntime } from '~/lib/cloudflare/runtime-session';
import { createCloudflareSetupCallbackURL, signInWithCloudflare } from '~/lib/auth-client';
import { messageInputStore } from '~/lib/stores/messageInput';
import { getAuthToken } from '~/lib/stores/sessionId';
import { debounce } from '~/utils/debounce';
import { LEGACY_PROMPT_COOKIE_KEY, PENDING_PROMPT_STORAGE_KEY } from '~/utils/constants';
import { useGhostbuildAuth } from './GhostbuildAuthWrapper';

interface MessageInputControllerOptions {
  isStreaming: boolean;
  onStop: () => void;
  onSend: (message: string) => Promise<boolean>;
  prefillEnabled?: boolean;
}

export function useMessageInputController({
  isStreaming,
  onStop,
  onSend,
  prefillEnabled = true,
}: MessageInputControllerOptions) {
  const [isEnhancing, setIsEnhancing] = useState(false);
  const enhanceRequestRef = useRef<AbortController | null>(null);
  const authState = useGhostbuildAuth();
  const input = useStore(messageInputStore);
  const search = useSearch({ strict: false }) as { prefill?: string };

  useEffect(clearLegacyPromptCookie, []);

  useEffect(() => {
    if (!prefillEnabled) {
      return;
    }

    messageInputStore.set(search.prefill || readPendingPrompt() || '');
  }, [prefillEnabled, search.prefill]);

  useEffect(
    () => () => {
      enhanceRequestRef.current?.abort();
    },
    [],
  );

  const send = useCallback(async () => {
    await submitMessageInput(input, onSend, () => {
      cachePrompt.cancel();
      removePendingPrompt();
      clearLegacyPromptCookie();
      messageInputStore.set('');
    });
  }, [input, onSend]);

  const signIn = useCallback(async () => {
    preservePromptForAuthentication(input);
    try {
      await signInWithCloudflare(createCloudflareSetupCallbackURL());
    } catch (error) {
      captureException('Failed to start Cloudflare authorization', error, { level: 'error' });
      toast.error(error instanceof Error ? error.message : 'Unable to connect Cloudflare. Please try again.');
    }
  }, [input]);

  const runPrimaryAction = useCallback(() => {
    switch (getMessageInputPrimaryAction(authState.kind, isStreaming)) {
      case 'stop':
        onStop();
        return;
      case 'sign-in':
        void signIn();
        return;
      case 'send':
        void send();
        return;
      case 'wait':
        return;
    }
  }, [authState.kind, isStreaming, onStop, send, signIn]);

  const handleButtonClick = useCallback(() => {
    runPrimaryAction();
  }, [runPrimaryAction]);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      if (!event.nativeEvent.isComposing) {
        runPrimaryAction();
      }
    },
    [runPrimaryAction],
  );

  const handleChange: ChangeEventHandler<HTMLTextAreaElement> = useCallback((event) => {
    messageInputStore.set(event.target.value);
    cachePrompt(event.target.value);
  }, []);

  const enhancePrompt = useCallback(async () => {
    const sourceInput = input;
    enhanceRequestRef.current?.abort();
    const controller = new AbortController();
    enhanceRequestRef.current = controller;
    try {
      setIsEnhancing(true);
      if (!getAuthToken()) {
        throw new Error('No auth token');
      }
      const response = await fetchUserRuntime('/v1/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: input.trim() }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          code?: 'workers_paid_required';
          error?: string;
        } | null;
        if (payload?.code === 'workers_paid_required' || payload?.error?.includes(WORKERS_PAID_REQUIRED_MARKER)) {
          showWorkersPaidRequiredToast();
          return;
        }
        throw new Error(payload?.error || 'Failed to enhance prompt. Please try again.');
      }
      const data = (await response.json()) as { enhancedPrompt?: string };
      if (data.enhancedPrompt && !controller.signal.aborted) {
        replacePromptIfUnchanged(sourceInput, data.enhancedPrompt);
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      captureException('Failed to enhance prompt', error, { level: 'error' });
      toast.error(error instanceof Error ? error.message : 'Failed to enhance prompt. Please try again.');
    } finally {
      if (enhanceRequestRef.current === controller) {
        enhanceRequestRef.current = null;
        setIsEnhancing(false);
      }
    }
  }, [input]);

  return {
    authState,
    enhancePrompt,
    handleButtonClick,
    handleChange,
    handleKeyDown,
    input,
    isEnhancing,
    signIn,
  };
}

export function getMessageInputPrimaryAction(
  authKind: 'loading' | 'unauthenticated' | 'fullyLoggedIn',
  isStreaming: boolean,
): 'stop' | 'sign-in' | 'send' | 'wait' {
  if (isStreaming) {
    return 'stop';
  }
  if (authKind === 'loading') {
    return 'wait';
  }
  return authKind === 'unauthenticated' ? 'sign-in' : 'send';
}

export function getMessageInputPrimaryActionLabel(
  authKind: 'loading' | 'unauthenticated' | 'fullyLoggedIn',
  isStreaming: boolean,
): 'Stop' | 'Connect Cloudflare' | 'Send' {
  const action = getMessageInputPrimaryAction(authKind, isStreaming);
  return action === 'stop' ? 'Stop' : action === 'sign-in' ? 'Connect Cloudflare' : 'Send';
}

export function replacePromptIfUnchanged(sourceInput: string, enhancedPrompt: string): boolean {
  if (messageInputStore.get() !== sourceInput) {
    return false;
  }
  messageInputStore.set(enhancedPrompt);
  return true;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

const cachePrompt = debounce(function cachePrompt(prompt: string) {
  storePendingPrompt(prompt.trim());
}, 1000);

export function preservePromptForAuthentication(input: string): void {
  cachePrompt.cancel();
  storePendingPrompt(input.trim());
  clearLegacyPromptCookie();
}

export function clearLegacyPromptCookie(): void {
  if (typeof document === 'undefined') {
    return;
  }
  document.cookie = `${LEGACY_PROMPT_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function readPendingPrompt(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_PROMPT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storePendingPrompt(prompt: string): void {
  try {
    if (prompt) {
      window.sessionStorage.setItem(PENDING_PROMPT_STORAGE_KEY, prompt);
    } else {
      window.sessionStorage.removeItem(PENDING_PROMPT_STORAGE_KEY);
    }
  } catch {
    // Prompt handoff remains best-effort when browser storage is unavailable.
  }
}

function removePendingPrompt(): void {
  try {
    window.sessionStorage.removeItem(PENDING_PROMPT_STORAGE_KEY);
  } catch {
    // Browser storage can be unavailable in privacy-restricted contexts.
  }
}

export async function submitMessageInput(
  input: string,
  onSend: (message: string) => Promise<boolean>,
  onAccepted: () => void,
): Promise<boolean> {
  const message = input.trim();
  if (!message) {
    return false;
  }
  const accepted = await onSend(message);
  if (!accepted) {
    return false;
  }
  onAccepted();
  return true;
}
