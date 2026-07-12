import type { ComponentProps, ReactNode } from 'react';
import { Button } from './Button';

type MenuProps = {
  children: ReactNode;
  buttonProps?: ComponentProps<typeof Button>;
};

export function Menu({ children, buttonProps }: MenuProps) {
  return (
    <div className="relative inline-flex">
      <details>
        <summary className="list-none">
          <Button {...buttonProps} />
        </summary>
        <div className="border-bolt-elements-borderColor absolute right-0 z-50 mt-2 min-w-56 rounded-2xl border bg-bolt-elements-background-depth-1 p-2 shadow-xl">
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
      onClick={action}
    >
      {children}
    </button>
  );
}
