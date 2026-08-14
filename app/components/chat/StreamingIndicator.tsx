import { motion } from 'framer-motion';
import type { StreamStatus } from '~/lib/common/types';
import { useStore } from '@nanostores/react';
import { chatStore } from '~/lib/stores/chatId';
import { Spinner } from '@ui/Spinner';
import { ExclamationTriangleIcon, ResetIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { BuildProgress } from './build-progress';

const logger = createScopedLogger('StreamingIndicator');

interface StreamingIndicatorProps {
  streamStatus: StreamStatus;
  isRecovering?: boolean;
  currentError?: Error;
  buildProgress: BuildProgress | null;
  isProjectUpdate: boolean;
  submissionPending: boolean;
  resendMessage: () => void;
}

// Icon components
const WarningIcon = () => <ExclamationTriangleIcon className="text-[var(--gb-content-warning)]" />;
const LoadingIcon = () => <Spinner />;

// Status messages
export const STATUS_MESSAGES = {
  building: 'Building...',
  recovering: 'Recovering interrupted response...',
  stopped: 'Generation stopped',
  error: 'The model hit an error. Try sending your message again.',
} as const;

function streamErrorMessage(currentError: Error | undefined): React.ReactNode {
  if (!currentError) {
    return STATUS_MESSAGES.error;
  }

  try {
    const { error, details } = JSON.parse(currentError.message);

    if (details) {
      logger.debug('Error details', details);
    }

    return typeof error === 'string' ? error : STATUS_MESSAGES.error;
  } catch {
    logger.debug('Failed to parse stream error', currentError);
    return STATUS_MESSAGES.error;
  }
}

export default function StreamingIndicator(props: StreamingIndicatorProps) {
  const { aborted } = useStore(chatStore);

  let streamStatus = props.streamStatus;
  if (props.isRecovering) {
    streamStatus = 'streaming';
  }

  if (streamStatus === 'ready' && !props.submissionPending && !aborted) {
    return null;
  }

  let icon: React.ReactNode;
  let message: React.ReactNode;

  if (props.submissionPending && streamStatus === 'ready') {
    icon = <LoadingIcon />;
    message = props.isProjectUpdate ? 'Preparing your changes…' : 'Preparing your project…';
  } else if (aborted) {
    icon = <WarningIcon />;
    message = STATUS_MESSAGES.stopped;
  } else {
    switch (streamStatus) {
      case 'submitted':
      case 'streaming':
        icon = <LoadingIcon />;
        message =
          props.buildProgress?.message ?? (props.isRecovering ? STATUS_MESSAGES.recovering : STATUS_MESSAGES.building);
        break;
      case 'error':
        icon = <WarningIcon />;
        message = streamErrorMessage(props.currentError);
        break;
      case 'ready':
        break;
    }
  }

  const retryLabel =
    streamStatus === 'error' ? 'Resend' : aborted && streamStatus === 'ready' ? 'Try again' : undefined;

  return (
    <motion.div
      className="mb-2 mt-1 w-full max-w-chat"
      initial={{ translateY: '100%' }}
      animate={{ translateY: '0%' }}
      exit={{ translateY: '100%' }}
      transition={{ duration: 0.15 }}
    >
      <div
        data-streaming-indicator-stream-status={streamStatus}
        className="z-prompt relative mx-auto w-full max-w-chat"
        role="status"
        aria-live="polite"
      >
        <div className="text-content-secondary flex px-1 py-1.5">
          <div className="flex-1">
            <div className="actions">
              <div className="flex gap-3 text-xs font-medium">
                <div className="flex w-full items-center gap-1.5">
                  <div>{icon}</div>
                  {message}
                  <div className="min-h-6 grow" />
                  {retryLabel && (
                    <Button type="button" className="ml-2 h-auto" onClick={props.resendMessage} icon={<ResetIcon />}>
                      {retryLabel}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
