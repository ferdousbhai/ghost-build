import { Button } from '@ui/Button';
import { ArrowLeftIcon, ArrowRightIcon, PlusIcon, ResetIcon } from '@radix-ui/react-icons';
import { useCallback, useState } from 'react';
import { Combobox } from '@ui/Combobox';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { Spinner } from '@ui/Spinner';
import { useAreFilesSaving } from '~/lib/stores/fileUpdateCounter';
import { SubchatDialogs } from './SubchatDialogs';
import { createSubchatOptions, getSubchatNavigation, type SubchatSummary } from './subchat-model';

interface SubchatBarProps {
  subchats?: SubchatSummary[];
  currentSubchatIndex: number;
  isStreaming: boolean;
  chatDisabled: boolean;
  sessionId: string | null;
  handleCreateSubchat: () => void;
  onRewind?: (subchatIndex?: number, messageIndex?: number) => void;
  isSubchatLoaded: boolean;
}

export function SubchatBar({
  subchats,
  currentSubchatIndex,
  isStreaming,
  chatDisabled,
  sessionId,
  onRewind,
  handleCreateSubchat,
  isSubchatLoaded,
}: SubchatBarProps) {
  const [isRewindModalOpen, setIsRewindModalOpen] = useState(false);
  const [isAddChatModalOpen, setIsAddChatModalOpen] = useState(false);
  const areFilesSaving = useAreFilesSaving();

  const subchatCount = subchats?.length ?? 1;
  const { hasMultipleSubchats, canNavigatePrev, canNavigateNext, canCreateSubchat } = getSubchatNavigation(
    subchatCount,
    currentSubchatIndex,
    sessionId !== null,
  );

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

  const persistedSubchatOptions = createSubchatOptions(subchats);
  const subchatOptions = persistedSubchatOptions.some((option) => option.value === currentSubchatIndex)
    ? persistedSubchatOptions
    : [
        ...persistedSubchatOptions,
        {
          label: currentSubchatIndex === 0 ? 'Initial chat' : `Feature #${currentSubchatIndex}`,
          value: currentSubchatIndex,
        },
      ];
  const visibleSubchatOptions = [...subchatOptions].reverse();

  return (
    <div className="sticky top-0 z-[2] mx-auto mb-5 w-full max-w-chat px-3 pt-4 sm:px-0">
      <SubchatDialogs
        rewindOpen={isRewindModalOpen}
        createOpen={isAddChatModalOpen}
        closeRewind={() => setIsRewindModalOpen(false)}
        closeCreate={() => setIsAddChatModalOpen(false)}
        confirmRewind={() => {
          setIsRewindModalOpen(false);
          onRewind?.(currentSubchatIndex, undefined);
        }}
        confirmCreate={() => {
          setIsAddChatModalOpen(false);
          handleCreateSubchat();
        }}
      />
      <div className="border-content-secondary/15 bg-background-secondary/85 flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 shadow-sm backdrop-blur-xl">
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
              disabled={chatDisabled || isStreaming || !isSubchatLoaded || areFilesSaving}
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
