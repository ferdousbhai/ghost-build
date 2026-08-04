import { memo } from 'react';
import { ArrowRightIcon, ExclamationTriangleIcon, StopIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { KeyboardShortcut } from '@ui/KeyboardShortcut';
import { Spinner } from '@ui/Spinner';
import { Tooltip } from '@ui/Tooltip';
import { CloudflareConnectLegalNotice } from '~/components/CloudflareConnectLegalNotice';
import { classNames } from '~/utils/classNames';
import { EnhancePromptButton } from './EnhancePromptButton.client';
import { MESSAGE_INPUT_HIGHLIGHTS, TextareaWithHighlights } from './MessageInputHighlights';
import { getMessageInputPrimaryActionLabel, useMessageInputController } from './useMessageInputController';

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
  const primaryActionLabel = getMessageInputPrimaryActionLabel(authState.kind, isStreaming);
  const hasActiveSession = authState.kind === 'fullyLoggedIn';
  const placeholder = chatStarted
    ? numMessages !== undefined && numMessages > 0
      ? 'Request changes by sending another message…'
      : 'Send a prompt for a new feature…'
    : 'Describe the app, workflow, and data you want to build…';
  const inputStatus =
    input.length > PROMPT_LENGTH_WARNING_THRESHOLD ? (
      <CharacterWarning />
    ) : input.length > 3 ? (
      <NewLineShortcut />
    ) : null;
  const actions = (
    <>
      {chatStarted && authState.kind === 'unauthenticated' && (
        <Button variant="neutral" onClick={() => void controller.signIn()} size="xs" className="text-xs font-normal">
          <span>Connect Cloudflare</span>
        </Button>
      )}
      {chatStarted && hasActiveSession && (
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
        tip={authState.kind === 'unauthenticated' ? 'Connect Cloudflare to continue' : undefined}
        onClick={controller.handleButtonClick}
        size="xs"
        className={classNames('ml-1 h-8 min-w-8 rounded-full', !chatStarted ? 'ghost-message-input__send' : '')}
        aria-label={primaryActionLabel}
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
    </>
  );

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
            'ghost-message-input__editor relative border border-bolt-elements-borderColor transition-all has-[textarea:focus]:border-border-selected',
            chatStarted ? 'rounded-2xl' : 'rounded-xl',
          )}
        >
          <TextareaWithHighlights
            onKeyDown={controller.handleKeyDown}
            onChange={controller.handleChange}
            value={input}
            minHeight={chatStarted ? 72 : 44}
            maxHeight={chatStarted ? 400 : 180}
            placeholder={placeholder}
            disabled={disabled}
            highlights={MESSAGE_INPUT_HIGHLIGHTS}
            contentClassName={chatStarted ? 'pb-14' : undefined}
          />
          {chatStarted && (
            <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex items-end gap-2">
              <div className="pointer-events-auto min-w-0 flex-1 pl-1">{inputStatus}</div>
              <div className="pointer-events-auto ml-auto flex items-center gap-1">{actions}</div>
            </div>
          )}
        </div>
        {!chatStarted && (
          <div className="ghost-message-input__footer flex flex-wrap items-center gap-2 rounded-b-xl border border-t-0 border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-1.5 text-sm">
            <div className="ml-auto flex items-center gap-1">{actions}</div>
          </div>
        )}
      </div>
      {authState.kind === 'unauthenticated' && (
        <CloudflareConnectLegalNotice className="mx-auto mt-2 max-w-2xl px-2 text-center text-[11px] leading-relaxed text-content-tertiary" />
      )}
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
