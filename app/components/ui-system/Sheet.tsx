import type { HTMLAttributes } from 'react';
import { classNames } from '~/utils/classNames';

export function Sheet({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={classNames(
        'rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 shadow-sm',
        className,
      )}
      {...props}
    />
  );
}
