import type { InputHTMLAttributes, Ref } from 'react';
import { classNames } from '~/utils/classNames';

export function TextInput({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={classNames(
        'min-h-9 rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-1.5 text-sm text-content-primary outline-none transition-shadow focus:border-accent-500 focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ghost-home-accent)_12%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}
