import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import useVersionNotificationBanner from '~/components/VersionNotificationBanner';
import { queryClient } from '~/lib/stores/reactQueryClient';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <VersionNotificationEffect />
      {children}
    </QueryClientProvider>
  );
}

function VersionNotificationEffect() {
  useVersionNotificationBanner();
  return null;
}
