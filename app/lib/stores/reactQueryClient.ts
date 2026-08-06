import { QueryClient } from '@tanstack/react-query';
import { UserRuntimeRequestError } from '~/lib/cloudflare/client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) =>
        failureCount < 2 &&
        !(error instanceof Error && error.name === 'AbortError') &&
        (!(error instanceof UserRuntimeRequestError) || error.retryable),
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
