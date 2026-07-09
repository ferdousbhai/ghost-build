import Cookies from 'js-cookie';
import { useStore } from '@nanostores/react';
import { EnhancePromptButton } from './EnhancePromptButton.client';
import { messageInputStore } from '~/lib/stores/messageInput';
import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ChangeEventHandler,
  type KeyboardEventHandler,
} from 'react';
import { useSearch } from '@tanstack/react-router';
import { classNames } from '~/utils/classNames';
import { PROMPT_COOKIE_KEY } from '~/utils/constants';
import { ArrowRightIcon, ExclamationTriangleIcon, StopIcon } from '@radix-ui/react-icons';
import { Tooltip } from '@ui/Tooltip';
import { useGhostbuildAuth } from './GhostbuildAuthWrapper';
import { getAuthToken } from '~/lib/stores/sessionId';
import { signInWithGoogle } from '~/lib/auth-client';
import { KeyboardShortcut } from '@ui/KeyboardShortcut';
import { Button } from '@ui/Button';
import { Spinner } from '@ui/Spinner';
import { debounce } from '~/utils/debounce';
import { toast } from 'sonner';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { captureException } from '~/lib/telemetry.client';

const PROMPT_LENGTH_WARNING_THRESHOLD = 2000;

type Highlight = {
  text: string; // must be lowercase
  tooltip: ReactNode;
};

const HIGHLIGHTS: Highlight[] = [
  {
    text: 'ai chat',
    tooltip: `Ghostbuild will prototype AI features with Cloudflare Workers AI and ${CLOUDFLARE_WORKERS_AI_MODEL}.`,
  },
  {
    text: 'collaborative text editor',
    tooltip:
      'Ghostbuild will use Cloudflare Agents or Durable Objects for coordination and TanStack DB for local live state.',
  },
  {
    text: 'upload',
    tooltip: 'Ghostbuild will use Cloudflare R2 for object storage and Worker routes for signed upload flows.',
  },
  {
    text: 'full text search',
    tooltip: 'Ghostbuild will use Cloudflare D1, Vectorize, or Worker-backed search APIs depending on the data model.',
  },
  {
    text: 'presence',
    tooltip: 'Ghostbuild will use Cloudflare Agents or Durable Objects for durable realtime presence state.',
  },
];

export const MessageInput = memo(function MessageInput({
  chatStarted,
  isStreaming,
  sendMessageInProgress,
  onStop,
  onSend,
  disabled,
  numMessages,
}: {
  chatStarted: boolean;
  isStreaming: boolean;
  sendMessageInProgress: boolean;
  onStop: () => void;
  onSend: (message: string) => Promise<void>;
  disabled: boolean;
  numMessages: number | undefined;
}) {
  const [isEnhancing, setIsEnhancing] = useState(false);
  const ghostbuildAuthState = useGhostbuildAuth();
  const hasActiveSession = ghostbuildAuthState.kind === 'guest' || ghostbuildAuthState.kind === 'fullyLoggedIn';

  const input = useStore(messageInputStore);

  // Set the initial input value
  const search = useSearch({ strict: false }) as { prefill?: string };
  useEffect(() => {
    messageInputStore.set(search.prefill || Cookies.get(PROMPT_COOKIE_KEY) || '');
  }, [search.prefill]);

  // Send messages
  const handleSend = useCallback(async () => {
    const trimmedInput = input.trim();
    if (trimmedInput.length === 0) {
      return;
    }

    await onSend(trimmedInput);

    cachePrompt.cancel();
    Cookies.remove(PROMPT_COOKIE_KEY);
    messageInputStore.set('');
  }, [input, onSend]);

  const handleClickButton = useCallback(() => {
    if (isStreaming) {
      onStop?.();
      return;
    }

    handleSend();
  }, [handleSend, isStreaming, onStop]);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      if (event.key === 'Enter') {
        if (event.shiftKey) {
          return;
        }

        event.preventDefault();

        if (isStreaming) {
          onStop?.();
          return;
        }

        // ignore if using input method engine
        if (event.nativeEvent.isComposing) {
          return;
        }

        handleSend();
      }
    },
    [handleSend, isStreaming, onStop],
  );

  const handleChange: ChangeEventHandler<HTMLTextAreaElement> = useCallback((event) => {
    const value = event.target.value;
    messageInputStore.set(value);
    cachePrompt(value);
  }, []);

  const enhancePrompt = useCallback(async () => {
    try {
      setIsEnhancing(true);

      if (!getAuthToken()) {
        throw new Error('No auth token');
      }
      const response = await fetch('/api/enhance-prompt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: input.trim(),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to enhance prompt. Please try again.');
      }

      const data = (await response.json()) as { enhancedPrompt?: string };
      if (data.enhancedPrompt) {
        messageInputStore.set(data.enhancedPrompt);
      }
    } catch (error) {
      captureException('Failed to enhance prompt', {
        level: 'error',
        extra: {
          error,
        },
      });
      toast.error(error instanceof Error ? error.message : 'Failed to enhance prompt. Please try again.');
    } finally {
      setIsEnhancing(false);
    }
  }, [input]);

  return (
    <div
      className={classNames(
        'relative z-20 mx-auto w-full shadow-sm transition-all duration-200',
        chatStarted ? 'max-w-chat' : 'ghost-message-input--home max-w-none',
      )}
    >
      <div
        className={classNames(
          'ghost-message-input__surface rounded-lg bg-bolt-elements-background-depth-1',
          !chatStarted ? 'p-2' : '',
        )}
      >
        <div
          className={classNames(
            'ghost-message-input__editor has-[textarea:focus]:border-border-selected border-bolt-elements-borderColor border transition-all',
            chatStarted ? 'rounded-t-lg' : 'rounded-md',
          )}
        >
          <TextareaWithHighlights
            onKeyDown={handleKeyDown}
            onChange={handleChange}
            value={input}
            minHeight={chatStarted ? 100 : 156}
            maxHeight={chatStarted ? 400 : 200}
            placeholder={
              chatStarted
                ? numMessages !== undefined && numMessages > 0
                  ? 'Request changes by sending another message…'
                  : 'Send a prompt for a new feature…'
                : 'Describe the app, workflow, and data you want to build…'
            }
            disabled={disabled}
            highlights={HIGHLIGHTS}
          />
        </div>
        <div
          className={classNames(
            'ghost-message-input__footer border-bolt-elements-borderColor flex flex-wrap items-center gap-2 border border-t-0 bg-bolt-elements-background-depth-2 p-1.5 text-sm',
            chatStarted ? 'rounded-b-lg' : 'rounded-b-md',
          )}
        >
          {input.length > 3 && input.length <= PROMPT_LENGTH_WARNING_THRESHOLD && <NewLineShortcut />}
          {input.length > PROMPT_LENGTH_WARNING_THRESHOLD && <CharacterWarning />}
          <div className="ml-auto flex items-center gap-1">
            {ghostbuildAuthState.kind === 'unauthenticated' && <SignInButton />}
            {hasActiveSession && (
              <EnhancePromptButton
                isEnhancing={isEnhancing}
                disabled={disabled || input.length === 0}
                onClick={enhancePrompt}
              />
            )}
            <Button
              disabled={
                (!isStreaming && input.length === 0) ||
                ghostbuildAuthState.kind === 'loading' ||
                sendMessageInProgress ||
                disabled
              }
              tip={ghostbuildAuthState.kind === 'unauthenticated' ? 'Please sign in to continue' : undefined}
              onClick={handleClickButton}
              size="xs"
              className={classNames('ml-2 h-[1.625rem] min-w-8', !chatStarted ? 'ghost-message-input__send' : '')}
              aria-label={isStreaming ? 'Stop' : 'Send'}
              icon={
                sendMessageInProgress ? (
                  <Spinner className="text-white" />
                ) : !isStreaming ? (
                  <ArrowRightIcon />
                ) : (
                  <StopIcon />
                )
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
});

const TextareaWithHighlights = memo(function TextareaWithHighlights({
  onKeyDown,
  onChange,
  value,
  minHeight,
  maxHeight,
  placeholder,
  disabled,
  highlights,
}: {
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onChange: ChangeEventHandler<HTMLTextAreaElement>;
  value: string;
  placeholder: string;
  disabled: boolean;
  minHeight: number;
  maxHeight: number;
  highlights: Highlight[];
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Textarea auto-sizing
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  const blocks = useMemo(() => {
    const highlightTooltips = new Map(highlights.map((highlight) => [highlight.text, highlight.tooltip]));
    const pattern = highlights
      .map((h) => h.text) // we assume text doesn’t contain special characters
      .join('|');
    const regex = new RegExp(pattern, 'gi');

    return Array.from(value.matchAll(regex)).map((match) => {
      const pos = match.index;
      return {
        from: pos,
        length: match[0].length,
        tip: highlightTooltips.get(match[0].toLowerCase()) ?? null,
      };
    });
  }, [highlights, value]);

  return (
    <div className="relative overflow-y-auto" style={{ minHeight, maxHeight }}>
      <textarea
        ref={textareaRef}
        className={classNames(
          'w-full px-3 py-3 outline-none resize-none text-content-primary placeholder-content-tertiary bg-transparent text-sm leading-snug',
          'transition-opacity',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'scrollbar-thin scrollbar-thumb-macosScrollbar-thumb scrollbar-track-transparent',
        )}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onChange={onChange}
        value={value}
        style={{ minHeight }}
        placeholder={placeholder}
        translate="no"
        // Disable Grammarly
        data-gramm="false"
      />

      <HighlightBlocks textareaRef={textareaRef} text={value} blocks={blocks} />
    </div>
  );
});

const HighlightBlocks = memo(function HighlightBlocks({
  text,
  blocks,
  textareaRef,
}: {
  text: string;
  blocks: {
    from: number;
    length: number;
    tip: ReactNode;
  }[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [forceRerender, setForceRerender] = useState(0);

  const [blockPositions, setBlockPositions] = useState<
    {
      top: number;
      left: number;
      width: number;
      height: number;
      tip: ReactNode;
    }[]
  >([]);

  // Rerender on textarea resize
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      throw new Error('Textarea not found');
    }

    const resizeObserver = new ResizeObserver(() => {
      setForceRerender((prev) => prev + 1);
    });
    resizeObserver.observe(textarea);
    return () => resizeObserver.disconnect();
  }, [textareaRef]);

  useLayoutEffect(() => {
    if (blocks.length === 0) {
      return;
    }

    const mirror = mirrorRef.current;
    const textNode = mirror?.firstChild;
    if (!mirror || !textNode) {
      return;
    }

    const wrapperRect = mirror.getBoundingClientRect();

    const positions = blocks.flatMap((block) => {
      const range = document.createRange();
      range.setStart(textNode, block.from);
      range.setEnd(textNode, block.from + block.length);

      const result: typeof blockPositions = [];
      for (const rect of range.getClientRects()) {
        result.push({
          top: rect.top - wrapperRect.top + mirror.scrollTop,
          left: rect.left - wrapperRect.left + mirror.scrollLeft,
          width: rect.width,
          height: rect.height,
          tip: block.tip,
        });
      }
      return result;
    });
    setBlockPositions(positions);
  }, [blocks, textareaRef, forceRerender]);

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div>
      <div
        ref={mirrorRef}
        className="pointer-events-none absolute inset-0 -z-20 whitespace-pre-wrap break-words p-3 text-sm leading-snug opacity-0"
        aria-hidden
      >
        {text}
      </div>

      <div>
        {blockPositions.map((block, index) => (
          <HighlightTooltip key={index} {...block} />
        ))}
      </div>
    </div>
  );
});

const HighlightTooltip = memo(function HighlightTooltip({
  tip,
  width,
  height,
  top,
  left,
}: {
  tip: ReactNode;
  width: number;
  height: number;
  top: number;
  left: number;
}) {
  return (
    <div
      className="absolute flex overflow-hidden bg-[#f8d077] mix-blend-color"
      style={{
        width,
        height,
        top,
        left,
      }}
    >
      <Tooltip className="absolute inset-0" tip={tip}>
        {null}
      </Tooltip>
    </div>
  );
});

const NewLineShortcut = memo(function NewLineShortcut() {
  return (
    <div className="text-content-tertiary text-xs">
      <KeyboardShortcut value={['Shift', 'Return']} className="mr-0.5 font-semibold" /> for new line
    </div>
  );
});

const CharacterWarning = memo(function CharacterWarning() {
  return (
    <Tooltip
      tip="Ghostbuild performs better with shorter prompts. Consider making your prompt more concise or breaking it into smaller chunks."
      side="bottom"
    >
      <div className="text-content-warning flex cursor-help items-center text-xs">
        <ExclamationTriangleIcon className="mr-1 size-4" />
        Prompt exceeds {PROMPT_LENGTH_WARNING_THRESHOLD.toLocaleString()} characters
      </div>
    </Tooltip>
  );
});

const SignInButton = memo(function SignInButton() {
  return (
    <Button
      variant="neutral"
      onClick={() => {
        void signInWithGoogle();
      }}
      size="xs"
      className="text-xs font-normal"
    >
      <span>Sign in</span>
    </Button>
  );
});

/**
 * Debounced function to cache the prompt in cookies.
 * Caches the trimmed value of the textarea input after a delay to optimize performance.
 */
const cachePrompt = debounce(function cachePrompt(prompt: string) {
  Cookies.set(PROMPT_COOKIE_KEY, prompt.trim(), { expires: 30 });
}, 1000);
