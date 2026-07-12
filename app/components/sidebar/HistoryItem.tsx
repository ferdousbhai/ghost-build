import { useParams } from '@tanstack/react-router';
import { classNames } from '~/utils/classNames';
import type { ChatHistorySummary } from '~/lib/cloudflare/data-api';
import { useEditChatDescription } from '~/lib/hooks/useEditChatDescription';
import { CheckIcon, Pencil1Icon, TrashIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';

interface HistoryItemProps {
  item: ChatHistorySummary;
  handleDeleteClick: (item: ChatHistorySummary) => void;
}

export function HistoryItem({ item, handleDeleteClick }: HistoryItemProps) {
  const { id: urlId } = useParams({ strict: false }) as { id?: string };
  const isActiveChat = urlId === item.id;

  const { editing, handleChange, handleBlur, handleSubmit, handleKeyDown, currentDescription, toggleEditMode } =
    useEditChatDescription({
      initialDescription: item.description,
      customChatId: item.id,
      syncWithGlobalStore: isActiveChat,
    });

  // Chats get a description from the first message, so have a fallback so
  // they render reasonably
  const description = currentDescription ?? 'New chat…';

  return (
    <div
      className={classNames(
        'group rounded-xl text-sm text-content-secondary hover:text-content-primary hover:bg-[var(--bolt-elements-sidebar-active-item-background)] overflow-hidden flex justify-between items-center px-3 py-2.5 transition-colors',
        { 'text-content-primary bg-[var(--bolt-elements-sidebar-active-item-background)]': isActiveChat },
      )}
    >
      {editing ? (
        <form onSubmit={handleSubmit} className="flex flex-1 items-center gap-2">
          <TextInput
            id="description"
            className="-ml-1.5 -mt-1.5"
            autoFocus
            value={currentDescription}
            onChange={handleChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />
          <Button type="submit" variant="neutral" icon={<CheckIcon />} size="xs" inline onClick={handleSubmit} />
        </form>
      ) : (
        <a href={`/chat/${item.urlId ?? item.initialId}`} className="relative flex w-full truncate">
          <span className="truncate pr-24">{description}</span>
          <div
            className={classNames(
              {
                'bg-[var(--bolt-elements-sidebar-active-item-background)]': isActiveChat,
                'bg-[var(--bolt-elements-sidebar-background)]': !isActiveChat,
              },
              'absolute right-0 top-0 bottom-0 flex items-center group-hover:bg-[var(--bolt-elements-sidebar-active-item-background)] px-2 transition-colors',
            )}
          >
            <div className="flex items-center gap-2.5 text-content-tertiary opacity-0 transition-opacity group-hover:opacity-100">
              <ChatActionButton
                toolTipContent="Rename"
                icon={<Pencil1Icon />}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  toggleEditMode();
                }}
              />
              <ChatActionButton
                toolTipContent="Delete"
                icon={<TrashIcon />}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleDeleteClick(item);
                }}
              />
            </div>
          </div>
        </a>
      )}
    </div>
  );
}

const ChatActionButton = ({
  toolTipContent,
  icon,
  className,
  onClick,
}: {
  toolTipContent: string;
  icon: React.ReactNode;
  className?: string;
  onClick: (e: React.MouseEvent) => void;
}) => {
  return (
    <Button
      variant="neutral"
      icon={icon}
      inline
      size="xs"
      tip={toolTipContent}
      className={className}
      onClick={onClick}
    />
  );
};
