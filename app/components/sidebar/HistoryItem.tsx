import { useParams } from '@tanstack/react-router';
import { classNames } from '~/utils/classNames';
import type { ChatHistorySummary } from '~/lib/cloudflare/data-api';
import { useEditChatDescription } from '~/lib/hooks/useEditChatDescription';
import { CheckIcon, FileTextIcon, Pencil1Icon, TrashIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { format } from 'date-fns';

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

  // New projects can be persisted before their first prompt supplies a title.
  // Keep those rows visible and distinguishable by showing their creation time.
  const description = currentDescription.trim() || 'Untitled project';
  const projectTime = format(new Date(item.timestamp), 'p');

  return (
    <div
      className={classNames(
        'group relative flex min-w-0 items-center gap-1 overflow-hidden rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-1.5 text-sm text-content-secondary transition-[border-color,background-color,box-shadow]',
        'hover:border-accent-500/40 hover:bg-[var(--bolt-elements-sidebar-active-item-background)] hover:shadow-sm',
        {
          'border-accent-500/60 bg-[var(--bolt-elements-sidebar-active-item-background)] shadow-sm': isActiveChat,
        },
      )}
    >
      {editing ? (
        <form onSubmit={handleSubmit} className="flex min-w-0 flex-1 items-center gap-2">
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
        <>
          <a
            href={`/chat/${item.urlId ?? item.initialId}`}
            className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg p-2 text-content-primary no-underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            aria-label={`${description}, ${projectTime}`}
          >
            <FileTextIcon className="mt-0.5 size-4 shrink-0 text-content-tertiary" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-semibold leading-5 text-content-primary">{description}</span>
              <span className="mt-0.5 text-xs leading-4 text-content-tertiary">{projectTime}</span>
            </span>
          </a>
          <div className="flex shrink-0 items-center gap-0.5 text-content-tertiary opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            <ChatActionButton
              toolTipContent="Rename"
              icon={<Pencil1Icon />}
              onClick={() => {
                toggleEditMode();
              }}
            />
            <ChatActionButton
              toolTipContent="Delete"
              icon={<TrashIcon />}
              onClick={() => {
                handleDeleteClick(item);
              }}
            />
          </div>
        </>
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
  onClick: () => void;
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
