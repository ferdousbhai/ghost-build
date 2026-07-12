import type { ReactNode } from 'react';

export function Tooltip({ children, tip, className }: { children: ReactNode; tip?: string; className?: string }) {
  return (
    <span className={className} title={tip}>
      {children}
    </span>
  );
}
