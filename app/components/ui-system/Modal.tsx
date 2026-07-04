import type { ReactNode } from 'react';

export function Modal({
  children,
  onClose,
  title,
  description,
}: {
  children: ReactNode;
  onClose?: () => void;
  title?: ReactNode;
  description?: ReactNode;
  size?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-md bg-bolt-elements-background-depth-1 p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>{title}</div>
          {onClose && (
            <button type="button" className="text-content-secondary hover:text-content-primary" onClick={onClose}>
              x
            </button>
          )}
        </div>
        {description && <p className="text-content-secondary mb-3 text-sm">{description}</p>}
        {children}
      </div>
    </div>
  );
}
