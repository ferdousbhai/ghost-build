import { forwardRef, type InputHTMLAttributes } from 'react';
import { classNames } from '~/utils/classNames';

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={classNames(
        'min-h-8 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 py-1 text-sm text-content-primary outline-none focus:border-accent-500',
        className,
      )}
      {...props}
    />
  );
});
