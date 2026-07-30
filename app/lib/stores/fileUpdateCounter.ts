import { useStore } from '@nanostores/react';
import { workbenchStore } from './workbench.client';

export function useAreFilesSaving() {
  return useStore(workbenchStore.unsavedFiles).size > 0;
}
