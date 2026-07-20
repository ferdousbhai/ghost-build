import { CaretDownIcon, CaretUpIcon } from '@radix-ui/react-icons';
import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { cubicEasingFn } from '~/utils/easings';

export function ExpandableArtifactCard({
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
    <div className="artifact flex w-full flex-col overflow-hidden rounded-lg border duration-150">
      <div className="flex">
        <button
          type="button"
          className="flex w-full items-stretch overflow-hidden bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover"
          onClick={onOpen}
        >
          {leading && (
            <>
              <div className="p-4">{leading}</div>
              <div className="w-px bg-bolt-elements-artifacts-borderColor" />
            </>
          )}
          <div className="w-full p-3.5 px-5 text-left">{header}</div>
        </button>
        {onToggle && (
          <>
            <div className="w-px bg-bolt-elements-artifacts-borderColor" />
            <AnimatePresence>
              <motion.button
                type="button"
                aria-label={expanded ? 'Collapse artifact details' : 'Expand artifact details'}
                aria-expanded={expanded}
                initial={{ width: 0 }}
                animate={{ width: 'auto' }}
                exit={{ width: 0 }}
                transition={{ duration: 0.15, ease: cubicEasingFn }}
                className="bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover"
                disabled={toggleDisabled}
                onClick={onToggle}
              >
                <div className="p-4 text-content-primary">{expanded ? <CaretUpIcon /> : <CaretDownIcon />}</div>
              </motion.button>
            </AnimatePresence>
          </>
        )}
      </div>
      <AnimatePresence>
        {expanded && body && (
          <motion.div
            className="actions"
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div className="h-px bg-bolt-elements-artifacts-borderColor" />
            <div className="bg-bolt-elements-actions-background p-5 text-left">{body}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
