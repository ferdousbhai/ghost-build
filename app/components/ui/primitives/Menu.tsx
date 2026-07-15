import type { ComponentProps, ReactNode } from 'react';
import { buttonClassNames } from './Button';
import type { Button } from './Button';
import { classNames } from '~/utils/classNames';

type MenuProps = {
  children: ReactNode;
  buttonProps?: ComponentProps<typeof Button>;
};

export function Menu({ children, buttonProps }: MenuProps) {
  const triggerLabel = buttonProps?.['aria-label'];
  const triggerTitle = buttonProps?.tip ?? buttonProps?.title;

  return (
    <div className="relative inline-flex">
      <details>
        <summary
          aria-label={triggerLabel ?? triggerTitle}
          title={triggerTitle}
          className={classNames(
            buttonClassNames({
              className: buttonProps?.className,
              variant: buttonProps?.variant,
              size: buttonProps?.size,
              inline: buttonProps?.inline,
              focused: buttonProps?.focused,
            }),
            'cursor-pointer list-none [&::-webkit-details-marker]:hidden',
          )}
        >
          {buttonProps?.icon}
          {buttonProps?.children}
        </summary>
        <div className="border-bolt-elements-borderColor fixed top-[calc(var(--header-height)+0.5rem)] right-5 z-50 min-w-56 rounded-2xl border bg-bolt-elements-background-depth-1 p-2 shadow-xl">
          {children}
        </div>
      </details>
    </div>
  );
}

export function MenuItem({ children, action }: { children: ReactNode; action?: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-bolt-elements-background-depth-2"
      onClick={(event) => {
        event.currentTarget.closest('details')?.removeAttribute('open');
        action?.();
      }}
    >
      {children}
    </button>
  );
}
