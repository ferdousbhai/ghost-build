import { api } from '~/lib/cloudflare/data-api';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { description as descriptionStore } from '~/lib/stores/description';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { useChatId } from '~/lib/stores/chatId';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';

const logger = createScopedLogger('useEditChatDescription');

type DescriptionValidationResult = 'valid' | 'unchanged' | 'invalidLength' | 'invalidCharacters';

interface EditChatDescriptionOptions {
  initialDescription?: string;
  customChatId?: string;
  syncWithGlobalStore?: boolean;
}

type EditChatDescriptionHook = {
  editing: boolean;
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleBlur: () => Promise<void>;
  handleSubmit: (event: React.FormEvent) => Promise<void>;
  handleKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => Promise<void>;
  currentDescription: string;
  toggleEditMode: () => void;
};

/**
 * Hook to manage the state and behavior for editing chat descriptions.
 *
 * Offers functions to:
 * - Switch between edit and view modes.
 * - Manage input changes, blur, and form submission events.
 * - Save updates to IndexedDB and optionally to the global application state.
 *
 * @param {Object} options
 * @param {string} options.initialDescription - The current chat description.
 * @param {string} options.customChatId - Optional ID for updating the description via the sidebar.
 * @param {boolean} options.syncWithGlobalStore - Flag to indicate global description store synchronization.
 * @returns {EditChatDescriptionHook} Methods and state for managing description edits.
 */
export function useEditChatDescription({
  initialDescription = descriptionStore.get() ?? '',
  customChatId,
  syncWithGlobalStore,
}: EditChatDescriptionOptions): EditChatDescriptionHook {
  const chatIdFromRoute = useChatId();
  const userId = useUserIdOrNullOrLoading();
  const [editing, setEditing] = useState(false);
  const [currentDescription, setCurrentDescription] = useState(initialDescription);
  const chatId = customChatId || chatIdFromRoute;
  useEffect(() => {
    setCurrentDescription(initialDescription);
  }, [initialDescription]);

  const toggleEditMode = useCallback(() => setEditing((prev) => !prev), []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentDescription(e.target.value);
  }, []);

  const fetchLatestDescription = useCallback(async () => {
    if (!chatId || !userId) {
      return initialDescription;
    }

    try {
      const chat = await executeDataOperation(api.messages.get, { id: chatId, sessionId: userId });
      return chat?.description || initialDescription;
    } catch (error) {
      logger.error('Failed to fetch latest description:', error);
      return initialDescription;
    }
  }, [chatId, userId, initialDescription]);

  const handleBlur = useCallback(async () => {
    const latestDescription = await fetchLatestDescription();
    setCurrentDescription(latestDescription);
    toggleEditMode();
  }, [fetchLatestDescription, toggleEditMode]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();

      const validationResult = validateDescription(currentDescription, initialDescription);
      if (validationResult === 'unchanged') {
        toggleEditMode();
        return;
      }
      if (validationResult === 'invalidLength') {
        toast.error('Description must be between 1 and 100 characters.');
        return;
      }
      if (validationResult === 'invalidCharacters') {
        toast.error('Description can only contain letters, numbers, spaces, basic punctuation, and inline Markdown.');
        return;
      }

      try {
        if (!chatId || !userId) {
          toast.error('Chat Id is not available');
          return;
        }

        await executeDataOperation(api.messages.setDescription, {
          id: chatId,
          sessionId: userId,
          description: currentDescription,
        });

        if (syncWithGlobalStore) {
          descriptionStore.set(currentDescription);
        }

        toast.success('Chat description updated successfully');
      } catch (error) {
        toast.error('Failed to update chat description: ' + errorMessage(error));
      }

      toggleEditMode();
    },
    [currentDescription, chatId, initialDescription, toggleEditMode, syncWithGlobalStore, userId],
  );

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        await handleBlur();
      }
    },
    [handleBlur],
  );

  return {
    editing,
    handleChange,
    handleBlur,
    handleSubmit,
    handleKeyDown,
    currentDescription,
    toggleEditMode,
  };
}

function validateDescription(description: string, initialDescription: string): DescriptionValidationResult {
  const trimmedDescription = description.trim();

  if (trimmedDescription === initialDescription) {
    return 'unchanged';
  }

  if (trimmedDescription.length === 0 || trimmedDescription.length > 100) {
    return 'invalidLength';
  }

  return /^[a-zA-Z0-9\s\-_.,!?()[\]{}'"*~`]+$/.test(trimmedDescription) ? 'valid' : 'invalidCharacters';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
