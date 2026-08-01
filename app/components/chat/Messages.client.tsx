import { forwardRef, type ForwardedRef } from 'react';
import { classNames } from '~/utils/classNames';
import { AssistantMessage } from './AssistantMessage';
import { UserMessage } from './UserMessage';
import { useStore } from '@nanostores/react';
import { profileStore } from '~/lib/stores/profile';
import { ChatBubbleIcon, PersonIcon } from '@radix-ui/react-icons';
import { messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import styles from './BaseChat.module.css';

interface MessagesProps {
  id?: string;
  className?: string;
  messages?: GhostbuildMessage[];
  isStreaming?: boolean;
}

export const Messages = forwardRef<HTMLDivElement, MessagesProps>(function Messages(
  { id, messages = [], className, isStreaming }: MessagesProps,
  ref: ForwardedRef<HTMLDivElement> | undefined,
) {
  const profile = useStore(profileStore);

  return (
    <div id={id} className={className} ref={ref}>
      {messages.length > 0 ? (
        messages.map((message, index) => {
          const { role } = message;
          const isUserMessage = role === 'user';

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
