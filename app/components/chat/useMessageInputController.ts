import { useStore } from '@nanostores/react';
import { useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type ChangeEventHandler, type KeyboardEventHandler } from 'react';
import { toast } from 'sonner';
import { WORKERS_PAID_REQUIRED_MARKER } from '~/lib/workers-paid';
import { showWorkersPaidRequiredToast } from '~/lib/workers-paid.client';
import { captureException } from '~/lib/telemetry.client';
import { fetchUserRuntime } from '~/lib/cloudflare/runtime-session';
import { createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';
import { messageInputStore } from '~/lib/stores/messageInput';
import { isAuthenticated } from '~/lib/stores/userId';
import { debounce } from '~/utils/debounce';
import { PENDING_PROMPT_STORAGE_KEY } from '~/utils/constants';
import {
  promptRefinementResultSchema,
  type PromptRefinementAnswer,
  type PromptRefinementQuestion,
} from '~/lib/prompt-refinement';
import { useGhostbuildAuth } from './GhostbuildAuthWrapper';

interface MessageInputControllerOptions {
  isStreaming: boolean;
  onStop: () => void;
  onSend: (message: string, onAccepted?: () => void) => Promise<boolean>;
  prefillEnabled?: boolean;
}

export interface PromptRefinementSession {
  sourceInput: string;
  answers: PromptRefinementAnswer[];
  questions: PromptRefinementQuestion[];
}

export function useMessageInputController({
  isStreaming,
  onStop,
  onSend,
  prefillEnabled = true,
}: MessageInputControllerOptions) {
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [refinement, setRefinement] = useState<PromptRefinementSession | null>(null);
  const enhanceRequestRef = useRef<AbortController | null>(null);
  const authState = useGhostbuildAuth();
  const input = useStore(messageInputStore);
  const search = useSearch({ from: '__root__' });

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
      replacePromptIfUnchanged(input, '');
    });
  }, [input, onSend]);

  const signIn = useCallback(async () => {
    preservePromptForAuthentication(input);
    try {
      await signInWithCloudflare(createCloudflareReturnURL());
    } catch (error) {
      captureException('Failed to start Cloudflare authorization', error, { level: 'error' });
      toast.error(error instanceof Error ? error.message : 'Unable to connect Cloudflare. Please try again.');
    }
  }, [input]);

  const runPrimaryAction = useCallback(() => {
    switch (getMessageInputPrimaryAction(authState.kind, isStreaming, input.trim().length > 0)) {
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
  }, [authState.kind, input, isStreaming, onStop, send, signIn]);

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

  const requestPromptRefinement = useCallback(
    async (sourceInput: string, answers: PromptRefinementAnswer[], controller: AbortController) => {
      const response = await fetchUserRuntime('/v1/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: sourceInput.trim(), answers }),
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
        throw new Error(payload?.error || 'Failed to refine the build plan. Please try again.');
      }
      const result = promptRefinementResultSchema.safeParse(await response.json());
      if (!result.success) {
        throw new Error('Ghostbuild returned an invalid plan refinement response.');
      }
      if (controller.signal.aborted) {
        return;
      }
      if (result.data.kind === 'complete') {
        setRefinement(null);
        replacePromptIfUnchanged(sourceInput, result.data.enhancedPrompt);
        return;
      }
      setRefinement({ sourceInput, answers, questions: result.data.questions });
    },
    [],
  );

  const enhancePrompt = useCallback(async () => {
    const sourceInput = input;
    enhanceRequestRef.current?.abort();
    const controller = new AbortController();
    enhanceRequestRef.current = controller;
    try {
      setIsEnhancing(true);
      if (!isAuthenticated()) {
        throw new Error('Not authenticated');
      }
      setRefinement(null);
      await requestPromptRefinement(sourceInput, [], controller);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      captureException('Failed to enhance prompt', error, { level: 'error' });
      toast.error(error instanceof Error ? error.message : 'Failed to refine the build plan. Please try again.');
    } finally {
      if (enhanceRequestRef.current === controller) {
        enhanceRequestRef.current = null;
        setIsEnhancing(false);
      }
    }
  }, [input, requestPromptRefinement]);

  const answerRefinementQuestions = useCallback(
    async (roundAnswers: PromptRefinementAnswer[]) => {
      if (!refinement || isEnhancing) {
        return;
      }
      enhanceRequestRef.current?.abort();
      const controller = new AbortController();
      enhanceRequestRef.current = controller;
      const answers = [...refinement.answers, ...roundAnswers];
      try {
        setIsEnhancing(true);
        await requestPromptRefinement(refinement.sourceInput, answers, controller);
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        captureException('Failed to enhance prompt', error, { level: 'error' });
        toast.error(error instanceof Error ? error.message : 'Failed to refine the build plan. Please try again.');
      } finally {
        if (enhanceRequestRef.current === controller) {
          enhanceRequestRef.current = null;
          setIsEnhancing(false);
        }
      }
    },
    [isEnhancing, refinement, requestPromptRefinement],
  );

  const cancelRefinement = useCallback(() => {
    const controller = enhanceRequestRef.current;
    enhanceRequestRef.current = null;
    controller?.abort();
    setIsEnhancing(false);
    setRefinement(null);
  }, []);

  return {
    answerRefinementQuestions,
    authState,
    cancelRefinement,
    enhancePrompt,
    handleButtonClick,
    handleChange,
    handleKeyDown,
    input,
    isEnhancing,
    refinement,
    signIn,
  };
}

export function getMessageInputPrimaryAction(
  authKind: 'loading' | 'unauthenticated' | 'fullyLoggedIn',
  isStreaming: boolean,
  hasInput = false,
): 'stop' | 'sign-in' | 'send' | 'wait' {
  if (isStreaming) {
    return hasInput ? 'send' : 'stop';
  }
  if (authKind === 'loading') {
    return 'wait';
  }
  return authKind === 'unauthenticated' ? 'sign-in' : 'send';
}

export function getMessageInputPrimaryActionLabel(
  authKind: 'loading' | 'unauthenticated' | 'fullyLoggedIn',
  isStreaming: boolean,
  hasInput = false,
): 'Stop' | 'Connect Cloudflare' | 'Send' {
  const action = getMessageInputPrimaryAction(authKind, isStreaming, hasInput);
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
  onSend: (message: string, onAccepted?: () => void) => Promise<boolean>,
  onAccepted: () => void,
): Promise<boolean> {
  const message = input.trim();
  if (!message) {
    return false;
  }
  return onSend(message, onAccepted);
}
