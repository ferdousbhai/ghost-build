import type { ReactNode } from 'react';
import { classNames } from '~/utils/classNames';
import { Spinner } from './Spinner';

function Loading({ className }: { className?: string }) {
  return (
    <div className={classNames('flex items-center justify-center', className)}>
      <Spinner />
    </div>
  );
}

export function LoadingTransition({
  children,
  loading,
  loadingProps,
}: {
  children?: ReactNode;
  loading?: boolean;
  loadingProps?: { className?: string };
}) {
  return loading ? <Loading className={loadingProps?.className} /> : <>{children}</>;
}
