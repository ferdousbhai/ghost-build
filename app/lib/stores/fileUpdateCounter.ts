import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { IGNORED_PATHS } from '~/utils/constants';
import { chatSyncState } from './startup/chatSyncState';
import { waitForStoreCondition } from './waitForStore';

const fileUpdateCounter = atom(0);

let currentTimer: ReturnType<typeof setTimeout> | null = null;
let lastUpdated = 0;
const DEBOUNCE_TIME = 1000;

export function useAreFilesSaving() {
  const backupState = useStore(chatSyncState);
  const fileCounter = useFileUpdateCounter();

  return backupState.savedFileUpdateCounter !== fileCounter;
}

export function useFileUpdateCounter() {
  return useStore(fileUpdateCounter);
}

export function getFileUpdateCounter() {
  return fileUpdateCounter.get();
}

export function waitForFileUpdateCounterChanged(counter: number, signal?: AbortSignal) {
  return waitForStoreCondition(fileUpdateCounter, (newCounter) => newCounter !== counter, { signal });
}

export function incrementFileUpdateCounter(path: string) {
  if (IGNORED_PATHS.some((p) => path.startsWith(p))) {
    return;
  }
  if (currentTimer) {
    return;
  }
  const now = Date.now();
  const nextUpdate = lastUpdated + DEBOUNCE_TIME;
  if (now < nextUpdate) {
    currentTimer = setTimeout(update, nextUpdate - now);
    return;
  }
  update();
}

function update() {
  fileUpdateCounter.set(fileUpdateCounter.get() + 1);
  lastUpdated = Date.now();
  currentTimer = null;
}
