import { useHydrated } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export function ClientOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const hydrated = useHydrated();
  return hydrated ? children : fallback;
}
