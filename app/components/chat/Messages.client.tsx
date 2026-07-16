import { forwardRef, useState, type ForwardedRef } from 'react';
import { classNames } from '~/utils/classNames';
import { AssistantMessage } from './AssistantMessage';
import { UserMessage } from './UserMessage';
import { useStore } from '@nanostores/react';
import { profileStore } from '~/lib/stores/profile';
import { ChatBubbleIcon, PersonIcon, ResetIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { useEarliestRewindableMessageRank } from '~/lib/hooks/useEarliestRewindableMessageRank';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import styles from './BaseChat.module.css';

interface MessagesProps {
  id?: string;
  className?: string;
  messages?: GhostbuildMessage[];
  isStreaming?: boolean;
  subchatsLength?: number;
  onRewindToMessage?: (subchatIndex?: number, messageIndex?: number) => void;
}

export const Messages = forwardRef<HTMLDivElement, MessagesProps>(function Messages(
  { id, messages = [], className, isStreaming, onRewindToMessage, subchatsLength }: MessagesProps,
  ref: ForwardedRef<HTMLDivElement> | undefined,
) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedMessageIndex, setSelectedMessageIndex] = useState<number | null>(null);
  const [selectedSubchatIndex, setSelectedSubchatIndex] = useState<number | undefined>(undefined);
  const currentSubchatIndex = useStore(subchatIndexStore);
  const profile = useStore(profileStore);
  const earliestRewindableMessageRank = useEarliestRewindableMessageRank();
  const lastSubchatIndex = subchatsLength ? subchatsLength - 1 : undefined;

  return (
    <div id={id} className={className} ref={ref}>
      {isModalOpen && selectedMessageIndex !== null && (
        <Modal
          onClose={() => {
            setIsModalOpen(false);
            setSelectedMessageIndex(null);
          }}
          title={<div className="sr-only">Rewind to message</div>}
        >
          <div className="flex flex-col gap-2">
            <h2>Rewind to previous version</h2>
            <p className="text-content-primary text-sm">
              This will undo all changes after this message. Your current work will be lost and cannot be recovered.
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
                  setIsModalOpen(false);
                  setSelectedMessageIndex(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setIsModalOpen(false);
                  onRewindToMessage?.(selectedSubchatIndex, selectedMessageIndex);
                }}
              >
                Rewind
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {messages.length > 0 ? (
        messages.map((message, index) => {
          const { role } = message;
          const isUserMessage = role === 'user';
          const canRewindToMessage =
            earliestRewindableMessageRank != null &&
            !isUserMessage &&
            index >= earliestRewindableMessageRank &&
            index !== messages.length - 1 &&
            currentSubchatIndex !== undefined &&
            lastSubchatIndex !== undefined &&
            currentSubchatIndex === lastSubchatIndex;

          return (
            <div
              key={index}
              className={classNames(styles.Message, 'relative flex w-full gap-3', {
                [styles.UserMessage]: isUserMessage,
                [styles.AssistantMessage]: !isUserMessage,
              })}
            >
              {isUserMessage && (
                <div className="flex size-8 shrink-0 items-center justify-center self-start overflow-hidden rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-content-secondary">
                  {profile?.avatar ? (
                    <img
                      src={profile.avatar}
                      alt={profile?.username || 'User'}
                      className="size-full object-cover"
                      loading="eager"
                      decoding="sync"
                    />
                  ) : (
                    <PersonIcon className="size-3.5" />
                  )}
                </div>
              )}
              {isUserMessage ? (
                <UserMessage content={messageText(message)} />
              ) : (
                <AssistantMessage message={message} isStreaming={isStreaming && index === messages.length - 1} />
              )}
              {canRewindToMessage && (
                <Button
                  className="absolute bottom-[-5px] right-[-5px] bg-bolt-elements-background-depth-2 hover:bg-bolt-elements-background-depth-3"
                  onClick={() => {
                    setIsModalOpen(true);
                    setSelectedMessageIndex(index);
                    setSelectedSubchatIndex(currentSubchatIndex);
                  }}
                  variant="neutral"
                  size="xs"
                  tip="Rewind to this message"
                  title="Rewind to here"
                >
                  <ResetIcon className="text-content-primary size-4" />
                </Button>
              )}
            </div>
          );
        })
      ) : (
        <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
          <div className="mb-6 flex size-[64px] shrink-0 items-center justify-center rounded-full text-gray-600 dark:text-gray-500">
            <ChatBubbleIcon className="size-8" />
          </div>
          <h3 className="text-content-primary mb-2 text-xl font-semibold">
            Ready to build a new feature or fix a bug?
          </h3>
          <p className="text-content-secondary max-w-md">Send a message below to start on your next task!</p>
        </div>
      )}
    </div>
  );
});
