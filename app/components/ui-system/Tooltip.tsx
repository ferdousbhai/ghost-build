import type { ReactNode } from 'react';

export function Tooltip({
  children,
  tip,
  className,
}: {
  children: ReactNode;
  tip?: ReactNode;
  side?: string;
  className?: string;
}) {
  return (
    <span className={className} title={typeof tip === 'string' ? tip : undefined}>
      {children}
    </span>
  );
}
