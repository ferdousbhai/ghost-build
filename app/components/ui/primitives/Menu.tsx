import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { buttonClassNames, type ButtonVisualProps } from './Button';
import { classNames } from '~/utils/classNames';

type MenuProps = {
  children: ReactNode;
  buttonProps?: Pick<
    ButtonVisualProps,
    'children' | 'className' | 'focused' | 'icon' | 'inline' | 'size' | 'tip' | 'variant'
  > & {
    'aria-label'?: string;
    title?: string;
  };
};

export function Menu({ children, buttonProps }: MenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [canUsePortal, setCanUsePortal] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const triggerLabel = buttonProps?.['aria-label'];
  const triggerTitle = buttonProps?.tip ?? buttonProps?.title;

  useEffect(() => {
    setCanUsePortal(true);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerLabel ?? triggerTitle}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        title={triggerTitle}
        className={buttonClassNames({
          className: buttonProps?.className,
          variant: buttonProps?.variant,
          size: buttonProps?.size,
          inline: buttonProps?.inline,
          focused: buttonProps?.focused,
        })}
        onClick={() => setIsOpen((open) => !open)}
      >
        {buttonProps?.icon}
        {buttonProps?.children}
      </button>
      {canUsePortal &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={triggerLabel ?? triggerTitle}
            className={classNames(
              'fixed top-[calc(var(--header-height)+0.5rem)] right-4 z-50 min-w-52 overflow-hidden rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-1.5 text-content-primary shadow-[0_18px_50px_rgba(0,0,0,0.28)] outline-none backdrop-blur-xl sm:right-5',
              isOpen ? 'block' : 'hidden',
            )}
            onClick={() => setIsOpen(false)}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

export function MenuItem({ children, action }: { children: ReactNode; action?: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex min-h-10 w-full items-center gap-2.5 rounded-xl border-0 bg-transparent px-3 py-2 text-left text-sm font-medium text-content-primary outline-none transition-colors hover:bg-bolt-elements-background-depth-2 focus-visible:bg-bolt-elements-background-depth-2"
      onClick={action}
    >
      {children}
    </button>
  );
}
