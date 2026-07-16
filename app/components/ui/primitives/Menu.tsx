import type { ComponentProps, ReactNode } from 'react';
import { buttonClassNames } from './Button';
import type { Button } from './Button';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

type MenuProps = {
  children: ReactNode;
  buttonProps?: ComponentProps<typeof Button>;
};

export function Menu({ children, buttonProps }: MenuProps) {
  const triggerLabel = buttonProps?.['aria-label'];
  const triggerTitle = buttonProps?.tip ?? buttonProps?.title;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={triggerLabel ?? triggerTitle}
          title={triggerTitle}
          className={buttonClassNames({
            className: buttonProps?.className,
            variant: buttonProps?.variant,
            size: buttonProps?.size,
            inline: buttonProps?.inline,
            focused: buttonProps?.focused,
          })}
        >
          {buttonProps?.icon}
          {buttonProps?.children}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal forceMount>
        <DropdownMenu.Content
          forceMount
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 min-w-56 rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2 text-content-primary shadow-xl outline-none data-[state=closed]:hidden"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({ children, action }: { children: ReactNode; action?: () => void }) {
  return (
    <DropdownMenu.Item asChild onSelect={action}>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm outline-none hover:bg-bolt-elements-background-depth-2 focus-visible:bg-bolt-elements-background-depth-2 data-[highlighted]:bg-bolt-elements-background-depth-2"
      >
        {children}
      </button>
    </DropdownMenu.Item>
  );
}
