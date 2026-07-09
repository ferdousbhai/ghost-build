import type { ActionAlert } from '~/types/actions';
import ChatAlert from './ChatAlert';

interface ChatActionAlertProps {
  alert: ActionAlert | undefined;
  clearAlert: () => void;
  onSend: (messageInput: string) => Promise<void>;
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
          onSend(message);
          clearAlert();
        }}
      />
    </div>
  );
}
