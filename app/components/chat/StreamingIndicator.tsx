import { AnimatePresence, motion } from 'framer-motion';
import { isStreamStatusActive, type StreamStatus, type ToolStatus } from '~/lib/common/types';
import { useStore } from '@nanostores/react';
import { chatStore } from '~/lib/stores/chatId';
import { Spinner } from '@ui/Spinner';
import { ExclamationTriangleIcon, CheckCircledIcon, ResetIcon } from '@radix-ui/react-icons';
import { useEffect, useState } from 'react';
import { Button } from '@ui/Button';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { isActionStatusActive } from '~/lib/runtime/action-runner';

const logger = createScopedLogger('StreamingIndicator');

interface StreamingIndicatorProps {
  streamStatus: StreamStatus;
  numMessages: number;
  numSubchats: number;
  toolStatus?: ToolStatus;
  isRecovering?: boolean;
  currentError?: Error;
  resendMessage: () => void;
}

// Icon components
const WarningIcon = () => <ExclamationTriangleIcon className="text-[var(--gb-content-warning)]" />;
const LoadingIcon = () => <Spinner />;
const CheckIcon = () => <CheckCircledIcon />;

// Status messages
export const STATUS_MESSAGES = {
  building: 'Building...',
  recovering: 'Recovering interrupted response...',
  stopped: 'Generation stopped',
  error: 'The model hit an error. Try sending your message again.',
  generated: 'Response Generated',
} as const;

const BUILDING_SPLINES_MESSAGES = [
  'Sketching the interface...',
  'Wiring the Worker...',
  'Shaping the data model...',
  'Connecting the route...',
  'Preparing the preview...',
  'Checking the build...',
  'Composing the components...',
  'Syncing app state...',
  'Lining up the bindings...',
  'Drafting the agent flow...',
  'Assembling the project...',
  'Reading the project tree...',
  'Planning the next edit...',
  'Updating the template...',
  'Reviewing the output...',
];
const BUILDING_SPLINES_PROBABILITY = 0.2;
const BUILDING_SPLINES_DURATION = 4000;

function streamErrorMessage(currentError: Error | undefined): React.ReactNode {
  if (!currentError) {
    return STATUS_MESSAGES.error;
  }

  try {
    const { code, error, details } = JSON.parse(currentError.message);

    if (details) {
      logger.debug('Error details', details);
    }

    if (code !== 'missing-api-key') {
      return error;
    }

    return (
      <div>
        {error}{' '}
        <a href="/settings" className="text-content-link hover:underline">
          Configure Workers AI
        </a>{' '}
        and try again.
      </div>
    );
  } catch {
    logger.debug('Failed to parse stream error', currentError);
    return STATUS_MESSAGES.error;
  }
}

export default function StreamingIndicator(props: StreamingIndicatorProps) {
  const { aborted } = useStore(chatStore);

  let streamStatus = props.streamStatus;
  const anyToolRunning =
    props.toolStatus && Object.values(props.toolStatus).some((status) => isActionStatusActive(status));
  if (props.isRecovering || anyToolRunning) {
    streamStatus = 'streaming';
  }

  const [buildingMessage, setBuildingMessage] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    if (isStreamStatusActive(streamStatus)) {
      timer = setInterval(() => {
        let newMessage = null;
        if (Math.random() < BUILDING_SPLINES_PROBABILITY) {
          const randomIndex = Math.floor(Math.random() * BUILDING_SPLINES_MESSAGES.length);
          newMessage = BUILDING_SPLINES_MESSAGES[randomIndex];
        }
        setBuildingMessage(newMessage);
      }, BUILDING_SPLINES_DURATION);
    } else {
      setBuildingMessage(null);
    }
    return () => {
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [streamStatus]);

  if (streamStatus === 'ready' && props.numMessages === 0 && props.numSubchats === 1) {
    return null;
  }

  let icon: React.ReactNode;
  let message: React.ReactNode;

  if (aborted) {
    icon = <WarningIcon />;
    message = STATUS_MESSAGES.stopped;
  } else {
    switch (streamStatus) {
      case 'submitted':
      case 'streaming':
        icon = <LoadingIcon />;
        message = props.isRecovering ? STATUS_MESSAGES.recovering : buildingMessage || STATUS_MESSAGES.building;
        break;
      case 'error':
        icon = <WarningIcon />;
        message = streamErrorMessage(props.currentError);
        break;
      case 'ready':
        if (props.numMessages > 0) {
          icon = <CheckIcon />;
          message = STATUS_MESSAGES.generated;
        }
        break;
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        className="bg-background-secondary -mb-2 mt-2 w-full max-w-chat rounded-t-xl border pb-2 shadow"
        initial={{ translateY: '100%' }}
        animate={{ translateY: '0%' }}
        exit={{ translateY: '100%' }}
        transition={{ duration: 0.15 }}
      >
        <div
          data-streaming-indicator-stream-status={streamStatus}
          className="z-prompt relative mx-auto w-full max-w-chat rounded-t-xl border-none shadow-none"
        >
          <div className="bg-background-secondary/75 text-content-primary flex rounded-t-xl p-1.5">
            <div className="flex-1">
              <AnimatePresence>
                <div className="actions">
                  <div className="flex gap-3 text-sm">
                    <div className="flex w-full items-center gap-1.5">
                      <div className="">{icon}</div>
                      {message}
                      <div className="min-h-6 grow" />
                      {streamStatus === 'error' && (
                        <Button
                          type="button"
                          className="ml-2 h-auto"
                          onClick={props.resendMessage}
                          icon={<ResetIcon />}
                        >
                          Resend
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </AnimatePresence>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
