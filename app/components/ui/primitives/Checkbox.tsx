import type { InputHTMLAttributes } from 'react';
import { classNames } from '~/utils/classNames';

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <input
      {...props}
      type="checkbox"
      className={classNames('size-4 rounded border-bolt-elements-borderColor', className)}
    />
  );
}
