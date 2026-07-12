import { classNames } from '~/utils/classNames';

export function KeyboardShortcut({ value, className }: { value: string[]; className?: string }) {
  return <kbd className={classNames('rounded border px-1 py-0.5 text-xs', className)}>{value.join('+')}</kbd>;
}
