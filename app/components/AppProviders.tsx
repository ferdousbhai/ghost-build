import { QueryClientProvider } from '@tanstack/react-query';
import { ClientOnly } from '@tanstack/react-router';
import { createClientOnlyFn } from '@tanstack/react-start';
import { lazy, Suspense, type ReactNode } from 'react';
import { queryClient } from '~/lib/stores/reactQueryClient';

const LazyVersionNotificationEffect = lazy(() =>
  import('~/components/VersionNotificationBanner.client').then((mod) => ({
    default: mod.VersionNotificationEffect,
  })),
);
const getVersionNotificationEffect = createClientOnlyFn(() => LazyVersionNotificationEffect);

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ClientVersionNotificationEffect />
      {children}
    </QueryClientProvider>
  );
}

function ClientVersionNotificationEffect() {
  const Effect = getVersionNotificationEffect();
  return (
    <ClientOnly fallback={null}>
      <Suspense fallback={null}>{Effect ? <Effect /> : null}</Suspense>
    </ClientOnly>
  );
}
