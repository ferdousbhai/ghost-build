import { classNames } from '~/utils/classNames';

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={classNames(
        'inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
      aria-hidden="true"
    />
  );
}
