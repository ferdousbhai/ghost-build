import { motion, type Variants } from 'framer-motion';
import { memo, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmationDialog } from '@ui/ConfirmationDialog';
import { ThemeSwitch } from '~/components/ui/ThemeSwitch';
import type { ChatHistorySummary } from '~/lib/cloudflare/data-api';
import { cubicEasingFn } from '~/utils/easings';
import { logger } from 'ghostbuild-agent/utils/logger';
import { HistoryItem } from './HistoryItem';
import { binDates } from './date-binning';
import { useSearchFilter } from '~/lib/hooks/useSearchFilter';
import { classNames } from '~/utils/classNames';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { getKnownInitialId } from '~/lib/stores/chatId';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { PlusIcon } from '@radix-ui/react-icons';
import { removeChatHistoryItem, useChatHistory } from '~/lib/cloudflare/chat-history-db';

const menuVariants = {
  closed: {
    opacity: 0,
    visibility: 'hidden',
    left: '-340px',
    transition: {
      duration: 0.2,
      ease: cubicEasingFn,
    },
  },
  open: {
    opacity: 1,
    visibility: 'initial',
    left: 0,
    transition: {
      duration: 0.2,
      ease: cubicEasingFn,
    },
  },
} satisfies Variants;

interface MenuProps {
  isOpen: boolean;
  onClose: () => void;
}

export const Menu = memo(({ isOpen, onClose }: MenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const sessionId = useSessionIdOrNullOrLoading();
  const list = useChatHistory(sessionId);
  const [deleteTarget, setDeleteTarget] = useState<ChatHistorySummary | null>(null);

  const { filteredItems: filteredList, handleSearchChange } = useSearchFilter({
    items: list,
    searchFields: ['description'],
  });

  const deleteItem = async (item: ChatHistorySummary) => {
    if (!sessionId) {
      return;
    }

    try {
      await removeChatHistoryItem(sessionId, item.id);
      if (getKnownInitialId() === item.initialId) {
        // hard page navigation to clear the stores
        window.location.pathname = '/';
      }
    } catch (error) {
      toast.error('Failed to delete conversation');
      logger.error(error);
    }
  };

  const closeDialog = () => {
    setDeleteTarget(null);
  };

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Element;

      // Don't close if clicking on the hamburger icon
      if (target?.closest('[data-hamburger-menu]')) {
        return;
      }

      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  const handleDeleteClick = (item: ChatHistorySummary) => {
    setDeleteTarget(item);
  };

  // Don't show the menu at all when logged out
  if (sessionId === null) {
    return null;
  }

  return (
    <motion.div
      ref={menuRef}
      initial="closed"
      animate={isOpen ? 'open' : 'closed'}
      variants={menuVariants}
      style={{ width: '340px' }}
      className={classNames(
        'flex flex-col side-menu fixed top-0 h-full',
        'bg-[var(--bolt-elements-sidebar-background)] border-r',
        'shadow-sm text-sm',
        'z-30',
      )}
    >
      <div className="flex h-[var(--header-height)] items-center justify-between border-b px-4"></div>

      <div className="flex size-full flex-1 flex-col overflow-hidden">
        <div className="space-y-3 p-4">
          <Button className="w-fit" href="/" icon={<PlusIcon />}>
            Start new project
          </Button>
          <div className="relative w-full">
            <TextInput
              id="search-projects"
              type="search"
              placeholder="Search projects..."
              onChange={handleSearchChange}
              aria-label="Search projects"
            />
          </div>
        </div>
        <div className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400">Your Projects</div>
        <div className="flex-1 overflow-auto px-3 pb-3">
          {filteredList.length === 0 && (
            <div className="px-4 text-sm text-gray-500 dark:text-gray-400">
              {list.length === 0 ? 'No previous projects' : 'No matches found'}
            </div>
          )}
          {binDates(filteredList).map(({ category, items }) => (
            <div key={category} className="mt-2 space-y-1 first:mt-0">
              <div className="sticky top-0 z-10 bg-[var(--bolt-elements-sidebar-background)] px-3 py-1 text-xs font-medium text-gray-500 dark:text-gray-400">
                {category}
              </div>
              <div className="space-y-0.5 pr-1">
                {items.map((item) => (
                  <HistoryItem key={item.initialId} item={item} handleDeleteClick={handleDeleteClick} />
                ))}
              </div>
            </div>
          ))}
          {deleteTarget && (
            <ConfirmationDialog
              onClose={closeDialog}
              confirmText="Delete"
              onConfirm={() => {
                deleteItem(deleteTarget);
                closeDialog();
              }}
              dialogTitle="Delete Chat"
              dialogBody={
                <p>
                  You are about to delete{' '}
                  <span className="text-content-primary font-medium">{deleteTarget.description || 'New chat...'}</span>
                </p>
              }
            />
          )}
        </div>
        <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3 dark:border-gray-800">
          <ThemeSwitch />
        </div>
      </div>
    </motion.div>
  );
});

Menu.displayName = 'Menu';
