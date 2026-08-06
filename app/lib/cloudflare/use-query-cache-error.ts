import { hashKey, type QueryKey } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { queryClient } from '~/lib/stores/reactQueryClient';

/** Subscribe to one Query Cache entry without adding a second query observer. */
export function useQueryCacheError(queryKey: QueryKey | undefined): unknown {
  const queryHash = queryKey ? hashKey(queryKey) : undefined;
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === queryHash) {
          onStoreChange();
        }
      }),
    [queryHash],
  );
  const getSnapshot = useCallback(
    () => (queryHash ? queryClient.getQueryCache().get(queryHash)?.state.error : undefined),
    [queryHash],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}
