import type { ReactNode } from 'react';

export function ToolResultFrame({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-bolt-elements-artifacts-borderColor bg-bolt-elements-background-depth-1 font-mono text-sm text-content-primary">
      <div className="max-h-[400px] overflow-auto p-4">{children}</div>
    </div>
  );
}
