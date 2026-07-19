import Cookies from 'js-cookie';
import { useStore } from '@nanostores/react';
import { useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type ChangeEventHandler, type KeyboardEventHandler } from 'react';
import { toast } from 'sonner';
import { WORKERS_PAID_REQUIRED_MARKER } from '~/lib/workers-paid';
import { showWorkersPaidRequiredToast } from '~/lib/workers-paid.client';
import { captureException } from '~/lib/telemetry.client';
import { signInWithCloudflare } from '~/lib/auth-client';
import { messageInputStore } from '~/lib/stores/messageInput';
import { getAuthToken } from '~/lib/stores/sessionId';
import { debounce } from '~/utils/debounce';
import { PROMPT_COOKIE_KEY } from '~/utils/constants';
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

  useEffect(() => {
    if (!prefillEnabled) {
      return;
    }

    messageInputStore.set(search.prefill || Cookies.get(PROMPT_COOKIE_KEY) || '');
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
      Cookies.remove(PROMPT_COOKIE_KEY);
      messageInputStore.set('');
    });
  }, [input, onSend]);

  const handleButtonClick = useCallback(() => {
    if (isStreaming) {
      onStop();
      return;
    }
    void send();
  }, [isStreaming, onStop, send]);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      if (isStreaming) {
        onStop();
        return;
      }
      if (!event.nativeEvent.isComposing) {
        void send();
      }
    },
    [isStreaming, onStop, send],
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
      const response = await fetch('/api/enhance-prompt', {
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

  const signIn = useCallback(async () => {
    preservePromptForAuthentication(input);
    try {
      await signInWithCloudflare();
    } catch (error) {
      captureException('Failed to start Cloudflare authorization', error, { level: 'error' });
      toast.error(error instanceof Error ? error.message : 'Unable to connect Cloudflare. Please try again.');
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
  Cookies.set(PROMPT_COOKIE_KEY, prompt.trim(), { expires: 30 });
}, 1000);

export function preservePromptForAuthentication(input: string): void {
  cachePrompt.cancel();
  const prompt = input.trim();
  if (prompt) {
    Cookies.set(PROMPT_COOKIE_KEY, prompt, { expires: 30 });
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
