import { memo } from 'react';
import { ArrowRightIcon, ExclamationTriangleIcon, StopIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { KeyboardShortcut } from '@ui/KeyboardShortcut';
import { Spinner } from '@ui/Spinner';
import { Tooltip } from '@ui/Tooltip';
import { classNames } from '~/utils/classNames';
import { EnhancePromptButton } from './EnhancePromptButton.client';
import { MESSAGE_INPUT_HIGHLIGHTS, TextareaWithHighlights } from './MessageInputHighlights';
import { useMessageInputController } from './useMessageInputController';

const PROMPT_LENGTH_WARNING_THRESHOLD = 2000;

interface MessageInputProps {
  chatStarted: boolean;
  isStreaming: boolean;
  sendMessageInProgress: boolean;
  onStop: () => void;
  onSend: (message: string) => Promise<boolean>;
  disabled: boolean;
  numMessages: number | undefined;
}

export const MessageInput = memo(function MessageInput({
  chatStarted,
  isStreaming,
  sendMessageInProgress,
  onStop,
  onSend,
  disabled,
  numMessages,
}: MessageInputProps) {
  const controller = useMessageInputController({ isStreaming, onStop, onSend, prefillEnabled: !chatStarted });
  const { authState, input } = controller;
  const hasActiveSession = authState.kind === 'guest' || authState.kind === 'fullyLoggedIn';
  const placeholder = chatStarted
    ? numMessages !== undefined && numMessages > 0
      ? 'Request changes by sending another message…'
      : 'Send a prompt for a new feature…'
    : 'Describe the app, workflow, and data you want to build…';

  return (
    <div
      className={classNames(
        'relative z-20 mx-auto w-full transition-all duration-200',
        chatStarted ? 'max-w-chat' : 'ghost-message-input--home max-w-none',
      )}
    >
      <div
        className={classNames(
          'ghost-message-input__surface rounded-2xl bg-bolt-elements-background-depth-1 shadow-[0_12px_36px_color-mix(in_srgb,var(--ghost-home-accent-2)_10%,transparent)]',
          !chatStarted ? 'p-2' : '',
        )}
      >
        <div
          className={classNames(
            'ghost-message-input__editor has-[textarea:focus]:border-border-selected border border-bolt-elements-borderColor transition-all',
            chatStarted ? 'rounded-t-2xl' : 'rounded-xl',
          )}
        >
          <TextareaWithHighlights
            onKeyDown={controller.handleKeyDown}
            onChange={controller.handleChange}
            value={input}
            minHeight={72}
            maxHeight={chatStarted ? 400 : 180}
            placeholder={placeholder}
            disabled={disabled}
            highlights={MESSAGE_INPUT_HIGHLIGHTS}
          />
        </div>
        <div
          className={classNames(
            'ghost-message-input__footer flex flex-wrap items-center gap-2 border border-t-0 border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-1.5 text-sm',
            chatStarted ? 'rounded-b-2xl' : 'rounded-b-xl',
          )}
        >
          {input.length > 3 && input.length <= PROMPT_LENGTH_WARNING_THRESHOLD && <NewLineShortcut />}
          {input.length > PROMPT_LENGTH_WARNING_THRESHOLD && <CharacterWarning />}
          <div className="ml-auto flex items-center gap-1">
            {authState.kind === 'unauthenticated' && (
              <Button
                variant="neutral"
                onClick={() => void controller.signIn()}
                size="xs"
                className="text-xs font-normal"
              >
                <span>Sign in</span>
              </Button>
            )}
            {hasActiveSession && (
              <EnhancePromptButton
                isEnhancing={controller.isEnhancing}
                disabled={disabled || input.length === 0}
                onClick={controller.enhancePrompt}
              />
            )}
            <Button
              disabled={
                (!isStreaming && input.length === 0) ||
                authState.kind === 'loading' ||
                (sendMessageInProgress && !isStreaming) ||
                disabled
              }
              tip={authState.kind === 'unauthenticated' ? 'Please sign in to continue' : undefined}
              onClick={controller.handleButtonClick}
              size="xs"
              className={classNames('ml-1 h-8 min-w-8 rounded-full', !chatStarted ? 'ghost-message-input__send' : '')}
              aria-label={isStreaming ? 'Stop' : 'Send'}
              icon={
                sendMessageInProgress && !isStreaming ? (
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

function NewLineShortcut() {
  return (
    <div className="text-xs text-content-tertiary">
      <KeyboardShortcut value={['Shift', 'Return']} className="mr-0.5 font-semibold" /> for new line
    </div>
  );
}

function CharacterWarning() {
  return (
    <Tooltip tip="Ghostbuild performs better with shorter prompts. Consider making your prompt more concise or breaking it into smaller chunks.">
      <div className="flex cursor-help items-center text-xs text-content-warning">
        <ExclamationTriangleIcon className="mr-1 size-4" />
        Prompt exceeds {PROMPT_LENGTH_WARNING_THRESHOLD.toLocaleString()} characters
      </div>
    </Tooltip>
  );
}
