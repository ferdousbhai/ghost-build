import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { chatSyncState } from './startup/chatSyncState';
import { waitForStoreCondition } from './waitForStore';

export const subchatIndexStore = atom<number | undefined>(undefined);

export function useIsSubchatLoaded() {
  const subchatIndex = useStore(subchatIndexStore);
  const syncState = useStore(chatSyncState);

  return syncState.subchatIndex === subchatIndex;
}

export function waitForSubchatIndexChanged(subchatIndex: number) {
  return waitForStoreCondition(subchatIndexStore, (newSubchatIndex) => newSubchatIndex !== subchatIndex);
}
