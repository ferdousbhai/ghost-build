import { CaretDownIcon, CaretUpIcon } from '@radix-ui/react-icons';
import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { cubicEasingFn } from '~/utils/easings';

export function ExpandableToolCard({
  body,
  expanded,
  header,
  leading,
  onOpen,
  onToggle,
  toggleDisabled,
}: {
  body?: ReactNode;
  expanded: boolean;
  header: ReactNode;
  leading?: ReactNode;
  onOpen: () => void;
  onToggle?: () => void;
  toggleDisabled?: boolean;
}) {
  return (
    <div className="tool-call-card flex w-full flex-col overflow-hidden rounded-lg border border-bolt-elements-artifacts-borderColor shadow-sm transition-[border-color,box-shadow] duration-150">
      <div className="flex">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-stretch overflow-hidden bg-bolt-elements-artifacts-background outline-none transition-colors hover:bg-bolt-elements-artifacts-backgroundHover focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
          onClick={onOpen}
        >
          {leading && <div className="border-r border-bolt-elements-artifacts-borderColor p-4">{leading}</div>}
          <div className="w-full p-3.5 px-5 text-left">{header}</div>
        </button>
        {onToggle && (
          <motion.button
            type="button"
            aria-label={expanded ? 'Collapse tool details' : 'Expand tool details'}
            aria-expanded={expanded}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15, ease: cubicEasingFn }}
            className="flex shrink-0 items-center justify-center border-l border-bolt-elements-artifacts-borderColor bg-bolt-elements-artifacts-background p-4 text-content-primary outline-none transition-colors hover:bg-bolt-elements-artifacts-backgroundHover focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={toggleDisabled}
            onClick={onToggle}
          >
            {expanded ? <CaretUpIcon /> : <CaretDownIcon />}
          </motion.button>
        )}
      </div>
      <AnimatePresence>
        {expanded && body && (
          <motion.div
            className="tool-details border-t border-bolt-elements-artifacts-borderColor"
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div className="bg-bolt-elements-actions-background p-5 text-left">{body}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
