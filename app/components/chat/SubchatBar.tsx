import { Button } from '@ui/Button';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChatBubbleIcon,
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
  ResetIcon,
} from '@radix-ui/react-icons';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useState } from 'react';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { Spinner } from '@ui/Spinner';
import { useAreFilesSaving } from '~/lib/stores/fileUpdateCounter';
import { SubchatDialogs } from './SubchatDialogs';
import { createSubchatOptions, getSubchatLabel, getSubchatNavigation, type SubchatSummary } from './subchat-model';

interface SubchatBarProps {
  subchats?: SubchatSummary[];
  currentSubchatIndex: number;
  isStreaming: boolean;
  chatDisabled: boolean;
  sessionId: string | null;
  handleCreateSubchat: () => Promise<boolean>;
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
  const [isCreatingSubchat, setIsCreatingSubchat] = useState(false);
  const areFilesSaving = useAreFilesSaving();

  const subchatCount = subchats?.length ?? 1;
  const { hasMultipleSubchats, canNavigatePrev, canNavigateNext, canCreateSubchat } = getSubchatNavigation(
    subchatCount,
    currentSubchatIndex,
    sessionId !== null,
  );

  const busyTip = isCreatingSubchat
    ? 'Creating chat...'
    : isStreaming
      ? 'Wait for the current response to finish'
      : !isSubchatLoaded
        ? 'Loading...'
        : areFilesSaving
          ? 'Saving...'
          : undefined;
  const interactionsDisabled = busyTip !== undefined;

  const handleNavigateToSubchat = (index: number) => {
    if (!hasMultipleSubchats || interactionsDisabled || index < 0 || index >= subchatCount) {
      return;
    }
    subchatIndexStore.set(index);
  };

  const persistedSubchatOptions = createSubchatOptions(subchats);
  const fallbackSubchatLabel = getSubchatLabel(currentSubchatIndex);
  const subchatOptions = persistedSubchatOptions.some((option) => option.value === currentSubchatIndex)
    ? persistedSubchatOptions
    : [
        ...persistedSubchatOptions,
        {
          label: fallbackSubchatLabel,
          value: currentSubchatIndex,
        },
      ];
  const visibleSubchatOptions = [...subchatOptions].reverse();
  const currentSubchat = subchatOptions.find((option) => option.value === currentSubchatIndex);
  const currentSubchatLabel = currentSubchat?.label ?? fallbackSubchatLabel;
  const chatPositionLabel = hasMultipleSubchats ? `Chat ${currentSubchatIndex + 1} of ${subchatCount}` : 'Current chat';

  return (
    <div className="sticky top-0 z-[2] mx-auto mb-5 w-full max-w-chat px-3 pt-4 sm:px-0">
      <SubchatDialogs
        rewindOpen={isRewindModalOpen}
        createOpen={isAddChatModalOpen}
        rewindDisabled={interactionsDisabled}
        createDisabled={interactionsDisabled}
        closeRewind={() => setIsRewindModalOpen(false)}
        closeCreate={() => {
          if (!isCreatingSubchat) {
            setIsAddChatModalOpen(false);
          }
        }}
        createPending={isCreatingSubchat}
        confirmRewind={() => {
          if (interactionsDisabled) {
            return;
          }
          setIsRewindModalOpen(false);
          onRewind?.(currentSubchatIndex, undefined);
        }}
        confirmCreate={async () => {
          if (interactionsDisabled) {
            return;
          }
          setIsCreatingSubchat(true);
          try {
            if (await handleCreateSubchat()) {
              setIsAddChatModalOpen(false);
            }
          } finally {
            setIsCreatingSubchat(false);
          }
        }}
      />
      <div className="border-content-secondary/15 bg-background-secondary/85 flex items-center gap-2 rounded-2xl border p-2 shadow-sm backdrop-blur-xl">
        {hasMultipleSubchats && (
          <div className="bg-background-secondary flex shrink-0 rounded-xl border border-bolt-elements-borderColor">
            <Button
              size="sm"
              variant="neutral"
              className="!size-11 !min-h-11 rounded-r-none border-0 !px-0"
              icon={<ArrowLeftIcon />}
              inline
              aria-label="Previous chat"
              tip={busyTip ?? 'Previous chat'}
              disabled={!canNavigatePrev || interactionsDisabled}
              onClick={() => {
                handleNavigateToSubchat(currentSubchatIndex - 1);
              }}
            />
            <Button
              size="sm"
              variant="neutral"
              className="!size-11 !min-h-11 rounded-l-none border-0 border-l border-l-bolt-elements-borderColor !px-0"
              icon={<ArrowRightIcon />}
              inline
              aria-label="Next chat"
              tip={busyTip ?? 'Next chat'}
              disabled={!canNavigateNext || interactionsDisabled}
              onClick={() => {
                handleNavigateToSubchat(currentSubchatIndex + 1);
              }}
            />
          </div>
        )}

        <div className="min-w-0 grow">
          {hasMultipleSubchats ? (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild disabled={interactionsDisabled}>
                <button
                  type="button"
                  className="group flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 text-left text-content-primary outline-none transition-colors hover:bg-bolt-elements-background-depth-2 focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={`Switch chat. ${chatPositionLabel}: ${currentSubchatLabel}`}
                >
                  <ChatBubbleIcon className="size-4 shrink-0 text-content-secondary" />
                  <span className="min-w-0 grow">
                    <span className="block whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.12em] text-content-secondary">
                      {chatPositionLabel}
                    </span>
                    <span className="block truncate text-sm font-medium" title={currentSubchatLabel}>
                      {currentSubchatLabel}
                    </span>
                  </span>
                  <ChevronDownIcon className="size-4 shrink-0 text-content-secondary transition-transform group-data-[state=open]:rotate-180" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={8}
                  collisionPadding={12}
                  className="z-50 max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-[var(--radix-dropdown-menu-trigger-width)] min-w-72 overflow-y-auto rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-1.5 text-content-primary shadow-[0_18px_50px_rgba(0,0,0,0.28)] outline-none"
                  aria-label="Build history"
                >
                  <DropdownMenu.Label className="px-3 pb-2 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-content-secondary">
                    Build history
                  </DropdownMenu.Label>
                  <DropdownMenu.RadioGroup
                    value={String(currentSubchatIndex)}
                    onValueChange={(value) => {
                      const subchatIndex = Number(value);
                      if (Number.isInteger(subchatIndex)) {
                        handleNavigateToSubchat(subchatIndex);
                      }
                    }}
                  >
                    {visibleSubchatOptions.map((option) => {
                      const isCurrent = option.value === currentSubchatIndex;
                      return (
                        <DropdownMenu.RadioItem
                          key={String(option.value)}
                          value={String(option.value)}
                          className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors hover:bg-bolt-elements-background-depth-2 focus:bg-bolt-elements-background-depth-2 data-[state=checked]:bg-bolt-elements-background-depth-2"
                        >
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-xs font-semibold text-content-secondary">
                            {option.value + 1}
                          </span>
                          <span className="min-w-0 grow">
                            <span className="block truncate text-sm font-medium" title={option.label}>
                              {option.label}
                            </span>
                            <span className="block text-xs text-content-secondary">
                              {isCurrent ? 'Currently viewing' : `Chat ${option.value + 1}`}
                            </span>
                          </span>
                          {isCurrent && <CheckIcon className="size-4 shrink-0 text-accent-500" />}
                        </DropdownMenu.RadioItem>
                      );
                    })}
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : (
            <div className="flex min-h-11 min-w-0 items-center gap-3 px-2">
              <ChatBubbleIcon className="size-4 shrink-0 text-content-secondary" />
              <span className="min-w-0 grow">
                <span className="block whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.12em] text-content-secondary">
                  {chatPositionLabel}
                </span>
                <span className="block truncate text-sm font-medium text-content-primary" title={currentSubchatLabel}>
                  {currentSubchatLabel}
                </span>
              </span>
            </div>
          )}
        </div>

        {!isSubchatLoaded && <Spinner />}

        <div className="flex shrink-0 items-center">
          {canCreateSubchat ? (
            <Button
              size="sm"
              variant="neutral"
              className="!min-h-11 rounded-xl !px-3"
              icon={<PlusIcon />}
              disabled={chatDisabled || interactionsDisabled}
              inline
              aria-label="Start a new chat"
              tip={busyTip ?? (chatDisabled ? 'New chat unavailable' : 'Start a new chat with fresh context')}
              onClick={() => {
                setIsAddChatModalOpen(true);
              }}
            >
              <span className="hidden sm:inline">New chat</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="neutral"
              className="!min-h-11 rounded-xl !px-3"
              icon={<ResetIcon />}
              inline
              aria-label="Rewind project to this chat"
              tip={busyTip ?? 'Rewind project to this chat'}
              disabled={currentSubchatIndex < 0 || interactionsDisabled}
              onClick={() => {
                setIsRewindModalOpen(true);
              }}
            >
              <span className="hidden sm:inline">Rewind</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
