import { ArrowLeftIcon, ArrowRightIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';

interface SubchatDialogsProps {
  rewindOpen: boolean;
  createOpen: boolean;
  closeRewind: () => void;
  closeCreate: () => void;
  confirmRewind: () => void;
  confirmCreate: () => void;
}

export function SubchatDialogs(props: SubchatDialogsProps) {
  return (
    <>
      {props.rewindOpen && (
        <Modal onClose={props.closeRewind} title={<div className="sr-only">Rewind to previous chat</div>}>
          <div className="flex flex-col gap-2">
            <h2>Rewind to previous chat</h2>
            <p className="text-content-primary text-sm">
              This will undo all changes after this chat. Your current work will be lost and cannot be recovered.
            </p>
            <p className="text-content-primary text-sm">
              Your stored app data will be unaffected, so you may need to either clear or migrate your data in order to
              use this previous version.
            </p>
            <p className="text-content-primary text-sm">Are you sure you want to continue?</p>
            <DialogActions cancel={props.closeRewind} confirm={props.confirmRewind} confirmLabel="Rewind" danger />
          </div>
        </Modal>
      )}
      {props.createOpen && (
        <Modal onClose={props.closeCreate} title="Create new chat">
          <div className="flex flex-col gap-2">
            <p className="text-content-primary text-sm">
              This will create a new chat with fresh context. This can be useful for starting work on a new feature of
              your app, or fixing a bug unrelated to your recent changes. You can always navigate back to previous chats
              using{' '}
              <ArrowLeftIcon className="border-content-secondary/20 bg-background-secondary inline size-5 rounded border p-0.5" />{' '}
              <ArrowRightIcon className="border-content-secondary/20 bg-background-secondary inline size-5 rounded border p-0.5" />{' '}
              to view your chat history, but you won&apos;t be able to send more messages in previous chats.
            </p>
            <p className="text-content-primary text-sm">Are you sure you want to continue?</p>
            <DialogActions cancel={props.closeCreate} confirm={props.confirmCreate} confirmLabel="Create Chat" />
          </div>
        </Modal>
      )}
    </>
  );
}

function DialogActions({
  cancel,
  confirm,
  confirmLabel,
  danger = false,
}: {
  cancel: () => void;
  confirm: () => void;
  confirmLabel: string;
  danger?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="neutral" onClick={cancel}>
        Cancel
      </Button>
      <Button variant={danger ? 'danger' : 'primary'} onClick={confirm}>
        {confirmLabel}
      </Button>
    </div>
  );
}
