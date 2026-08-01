import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { chatCheckpointSyncState } from './startup/chatCheckpointSyncState';
import { waitForStoreCondition } from './waitForStore';

export const subchatIndexStore = atom<number | undefined>(undefined);

export function useIsSubchatLoaded() {
  const subchatIndex = useStore(subchatIndexStore);
  const syncState = useStore(chatCheckpointSyncState);

  return syncState.subchatIndex === subchatIndex;
}

export function waitForSubchatIndexChanged(subchatIndex: number, signal?: AbortSignal) {
  return waitForStoreCondition(subchatIndexStore, (newSubchatIndex) => newSubchatIndex !== subchatIndex, { signal });
}
