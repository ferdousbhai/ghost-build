import type { ActionAlert } from '~/types/actions';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import ChatAlert from './ChatAlert';

const logger = createScopedLogger('ChatActionAlert');

interface ChatActionAlertProps {
  alert: ActionAlert | undefined;
  clearAlert: () => void;
  onSend: (messageInput: string) => Promise<boolean>;
  className?: string;
}

export function ChatActionAlert({ alert, clearAlert, onSend, className = 'mb-4' }: ChatActionAlertProps) {
  if (!alert) {
    return null;
  }

  return (
    <div className={className}>
      <ChatAlert
        alert={alert}
        clearAlert={clearAlert}
        postMessage={(message) => {
          void onSend(message)
            .then((accepted) => {
              if (accepted) {
                clearAlert();
              }
            })
            .catch((error) => logger.warn('Failed to send action alert message', error));
        }}
      />
    </div>
  );
}
