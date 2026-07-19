import { skipToken, useMutation as useTanStackMutation, useQuery as useTanStackQuery } from '@tanstack/react-query';
import { executeDataOperation } from './client';
import type { DataOperationArgs, DataOperationPath, DataOperationResult, SubchatSummary } from './data-api';
import { loadAllSubchats } from './data-page-loader';

export function useQuery<Path extends DataOperationPath>(
  path: Path,
  args: DataOperationArgs<Path> | 'skip',
): DataOperationResult<Path> | undefined {
  const query = useTanStackQuery({
    queryKey: ['ghostbuild-data', path, args],
    queryFn: args === 'skip' ? skipToken : () => executeDataOperation(path, args),
  });

  if (args === 'skip') {
    return undefined;
  }
  if (query.error) {
    throw query.error;
  }
  return query.data;
}

export function useMutation<Path extends DataOperationPath>(path: Path) {
  const { mutateAsync } = useTanStackMutation<DataOperationResult<Path>, Error, DataOperationArgs<Path>>({
    mutationKey: ['ghostbuild-data', path],
    mutationFn: (args) => executeDataOperation(path, args),
  });
  return mutateAsync;
}

export function useAllSubchats(args: { chatId: string; sessionId: string } | 'skip'): SubchatSummary[] | undefined {
  const query = useTanStackQuery({
    queryKey: ['ghostbuild-data', 'subchats.get', args],
    queryFn: args === 'skip' ? skipToken : ({ signal }) => loadAllSubchats(args.chatId, args.sessionId, signal),
  });

  if (args === 'skip') {
    return undefined;
  }
  if (query.error) {
    throw query.error;
  }
  return query.data;
}
