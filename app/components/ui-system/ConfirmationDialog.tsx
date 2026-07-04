import type { ReactNode } from 'react';
import { Button } from './Button';

export function ConfirmationDialog({
  onClose,
  onConfirm,
  confirmText = 'Confirm',
  dialogTitle,
  dialogBody,
}: {
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  confirmText?: string;
  dialogTitle?: ReactNode;
  dialogBody?: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-md bg-bolt-elements-background-depth-1 p-4 shadow-xl">
        <h2 className="mb-2 text-base font-semibold">{dialogTitle}</h2>
        <div className="text-content-secondary text-sm">{dialogBody}</div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="neutral" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void onConfirm()}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}
