import { Button } from '@ui/Button';
import { ArrowLeftIcon, ArrowRightIcon, PlusIcon, ResetIcon } from '@radix-ui/react-icons';
import { useCallback, useState } from 'react';
import { Modal } from '@ui/Modal';
import { Combobox } from '@ui/Combobox';
import { TimestampDistance } from '~/components/ui/TimestampDistance';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { Spinner } from '@ui/Spinner';
import { useAreFilesSaving } from '~/lib/stores/fileUpdateCounter';

interface SubchatBarProps {
  subchats?: { subchatIndex: number; updatedAt: number; description?: string }[];
  currentSubchatIndex: number;
  isStreaming: boolean;
  disableChatMessage: boolean;
  sessionId: string | null;
  handleCreateSubchat: () => void;
  onRewind?: (subchatIndex?: number, messageIndex?: number) => void;
  isSubchatLoaded: boolean;
}

export function SubchatBar({
  subchats,
  currentSubchatIndex,
  isStreaming,
  disableChatMessage,
  sessionId,
  onRewind,
  handleCreateSubchat,
  isSubchatLoaded,
}: SubchatBarProps) {
  const [isRewindModalOpen, setIsRewindModalOpen] = useState(false);
  const [isAddChatModalOpen, setIsAddChatModalOpen] = useState(false);
  const areFilesSaving = useAreFilesSaving();

  const subchatCount = subchats?.length ?? 1;
  const latestSubchatIndex = subchatCount - 1;
  const hasMultipleSubchats = subchatCount > 1;
  const isLatestSubchat = currentSubchatIndex >= latestSubchatIndex;
  const canNavigatePrev = hasMultipleSubchats && currentSubchatIndex > 0;
  const canNavigateNext = hasMultipleSubchats && currentSubchatIndex < latestSubchatIndex;
  const canCreateSubchat = isLatestSubchat && sessionId !== null;

  const handleNavigateToSubchat = useCallback(
    (index: number) => {
      if (!hasMultipleSubchats) {
        return;
      }
      if (index < 0 || index >= subchatCount) {
        return;
      }

      subchatIndexStore.set(index);
    },
    [hasMultipleSubchats, subchatCount],
  );

  const handleRewind = useCallback(
    (subchatIndex?: number) => {
      onRewind?.(subchatIndex, undefined);
    },
    [onRewind],
  );

  const getSubchatDisplayName = useCallback(
    (subchat: { subchatIndex: number; description?: string }, arrayIndex: number) => {
      if (subchat.description) {
        return subchat.description;
      }
      return arrayIndex === 0 ? 'Initial chat' : `Feature #${arrayIndex}`;
    },
    [],
  );

  const subchatOptions =
    subchats?.map((subchat, arrayIndex) => ({
      label: getSubchatDisplayName(subchat, arrayIndex),
      value: subchat.subchatIndex,
      subchat,
      arrayIndex,
    })) ?? [];
  const visibleSubchatOptions = [...subchatOptions].reverse();

  return (
    <div className="sticky top-0 z-[2] mx-auto mb-4 w-full max-w-chat pt-4">
      {isRewindModalOpen && (
        <Modal
          onClose={() => {
            setIsRewindModalOpen(false);
          }}
          title={<div className="sr-only">Rewind to previous chat</div>}
        >
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
            <div className="flex justify-end gap-2">
              <Button
                variant="neutral"
                onClick={() => {
                  setIsRewindModalOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setIsRewindModalOpen(false);
                  handleRewind(currentSubchatIndex);
                }}
              >
                Rewind
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {isAddChatModalOpen && (
        <Modal
          onClose={() => {
            setIsAddChatModalOpen(false);
          }}
          title="Create new chat"
        >
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
            <div className="flex justify-end gap-2">
              <Button
                variant="neutral"
                onClick={() => {
                  setIsAddChatModalOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setIsAddChatModalOpen(false);
                  handleCreateSubchat();
                }}
              >
                Create Chat
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <div className="border-content-secondary/20 bg-background-secondary/90 flex items-center justify-between gap-2 rounded-lg border px-4 py-2 backdrop-blur-sm">
        <div className="flex min-w-0 grow items-center gap-2">
          <div className="bg-background-secondary flex rounded-lg border">
            <Button
              size="xs"
              variant="neutral"
              className="border-border-transparent dark:border-border-transparent rounded-r-none border-0"
              icon={<ArrowLeftIcon className="my-px" />}
              inline
              tip={
                isStreaming
                  ? 'Navigation disabled while generating a response'
                  : !isSubchatLoaded
                    ? 'Loading...'
                    : areFilesSaving
                      ? 'Saving...'
                      : 'Previous Chat'
              }
              disabled={!canNavigatePrev || isStreaming || !isSubchatLoaded || areFilesSaving}
              onClick={() => {
                handleNavigateToSubchat(currentSubchatIndex - 1);
              }}
            />
            <Button
              size="xs"
              variant="neutral"
              className="border-border-transparent dark:border-border-transparent rounded-l-none border-0"
              icon={<ArrowRightIcon className="my-px" />}
              inline
              tip={
                isStreaming
                  ? 'Navigation disabled while generating a response'
                  : !isSubchatLoaded
                    ? 'Loading...'
                    : areFilesSaving
                      ? 'Saving...'
                      : 'Next Chat'
              }
              disabled={!canNavigateNext || isStreaming || !isSubchatLoaded || areFilesSaving}
              onClick={() => {
                handleNavigateToSubchat(currentSubchatIndex + 1);
              }}
            />
          </div>

          <div className="flex items-center gap-2">
            <Combobox
              label="Select chat"
              labelHidden
              className="max-w-full"
              buttonClasses="w-full"
              disabled={isStreaming || !isSubchatLoaded}
              options={visibleSubchatOptions}
              selectedOption={currentSubchatIndex}
              setSelectedOption={(subchatIndex) => {
                if (subchatIndex !== null && !isStreaming && isSubchatLoaded) {
                  handleNavigateToSubchat(subchatIndex);
                }
              }}
              Option={({ value, inButton }) => {
                let option = subchatOptions.find((opt) => opt.value === value);
                // We optimistically add the current subchat if it hasn't been persisted yet
                if (!option && value === currentSubchatIndex) {
                  option = {
                    label: value === 0 ? 'Initial chat' : `Feature #${value}`,
                    value: currentSubchatIndex,
                    subchat: {
                      subchatIndex: currentSubchatIndex,
                      updatedAt: Date.now(),
                    },
                    arrayIndex: currentSubchatIndex,
                  };
                }
                if (!option) {
                  return null;
                }

                const { subchat } = option;

                return (
                  <div className="flex max-w-96 flex-col gap-1 truncate">
                    <div className="truncate text-sm">{option.label}</div>
                    {!inButton && (
                      <div className="text-left">
                        <TimestampDistance date={new Date(subchat.updatedAt)} />
                      </div>
                    )}
                  </div>
                );
              }}
            />
            {!isSubchatLoaded && <Spinner />}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canCreateSubchat ? (
            <Button
              size="xs"
              variant="neutral"
              className="bg-background-secondary flex rounded-lg border"
              icon={<PlusIcon className="my-px" />}
              disabled={disableChatMessage || isStreaming || !isSubchatLoaded || areFilesSaving}
              inline
              tip={
                isStreaming
                  ? 'New chats disabled while generating a response'
                  : !isSubchatLoaded
                    ? 'Loading...'
                    : areFilesSaving
                      ? 'Saving...'
                      : 'New Chat'
              }
              onClick={() => {
                setIsAddChatModalOpen(true);
              }}
            />
          ) : (
            <Button
              size="xs"
              variant="neutral"
              className="bg-background-secondary flex rounded-lg border"
              icon={<ResetIcon className="my-px" />}
              inline
              tip={!isSubchatLoaded ? 'Loading...' : 'Rewind to this chat'}
              disabled={currentSubchatIndex < 0 || !isSubchatLoaded}
              onClick={() => {
                setIsRewindModalOpen(true);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
