import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';

export const subchatIndexStore = atom<number | undefined>(undefined);
export const loadedSubchatIndexStore = atom<number | undefined>(undefined);

export function useIsSubchatLoaded() {
  const subchatIndex = useStore(subchatIndexStore);
  const loadedSubchatIndex = useStore(loadedSubchatIndexStore);

  return loadedSubchatIndex === subchatIndex;
}
