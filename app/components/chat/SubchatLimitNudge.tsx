import { Button } from '@ui/Button';
import { PlusIcon } from '@radix-ui/react-icons';
import { useAreFilesSaving } from '~/lib/stores/fileUpdateCounter';

interface SubchatLimitNudgeProps {
  messageCount: number;
  handleCreateSubchat: () => void;
}

export function SubchatLimitNudge({ messageCount, handleCreateSubchat }: SubchatLimitNudgeProps) {
  const areFilesSaving = useAreFilesSaving();

  return (
    <div className="mx-auto w-full max-w-chat rounded-lg border border-orange-200 bg-orange-50 p-4 dark:border-orange-800 dark:bg-orange-950">
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-3">
          <div>
            <h3 className="font-medium text-orange-800 dark:text-orange-200">Create a new chat</h3>
            <p className="mt-1 text-sm text-orange-700 dark:text-orange-300">
              This chat has {messageCount} messages. Start fresh; your work stays intact.
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            className="bg-orange-600 text-white hover:bg-orange-700"
            icon={<PlusIcon />}
            disabled={areFilesSaving}
            onClick={handleCreateSubchat}
          >
            New chat
          </Button>
        </div>
      </div>
    </div>
  );
}
