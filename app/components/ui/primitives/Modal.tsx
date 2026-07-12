import type { ReactNode } from 'react';
import { classNames } from '~/utils/classNames';

export function Modal({
  children,
  onClose,
  title,
  description,
  size = 'md',
}: {
  children: ReactNode;
  onClose?: () => void;
  title?: ReactNode;
  description?: ReactNode;
  size?: 'md' | 'lg';
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className={classNames(
          'max-h-[90vh] w-full overflow-auto rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-5 shadow-xl',
          size === 'lg' ? 'max-w-4xl' : 'max-w-lg',
        )}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>{title}</div>
          {onClose && (
            <button
              type="button"
              className="gb-icon-button flex size-8 items-center justify-center text-content-secondary hover:text-content-primary"
              aria-label="Close dialog"
              onClick={onClose}
            >
              <span aria-hidden>×</span>
            </button>
          )}
        </div>
        {description && <p className="mb-3 text-sm text-content-secondary">{description}</p>}
        {children}
      </div>
    </div>
  );
}
