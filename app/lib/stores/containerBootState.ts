import { atom } from 'nanostores';
import { useStore } from '@nanostores/react';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { waitForStoreValue } from './waitForStore';

const logger = createScopedLogger('ContainerBootState');

export enum ContainerBootState {
  ERROR = -1,

  STARTING = 0,
  LOADING_SNAPSHOT = 1,
  DOWNLOADING_DEPENDENCIES = 2,
  STARTING_BACKUP = 3,
  READY = 4,
}

const containerBootStore = atom<{ state: ContainerBootState; startTime: number; errorToLog?: Error }>({
  state: ContainerBootState.STARTING,
  startTime: Date.now(),
});

export function useContainerBootState() {
  return useStore(containerBootStore);
}

export function setContainerBootState(state: ContainerBootState, error?: Error) {
  const existing = containerBootStore.get();
  const msg = `Container boot [${(Date.now() - existing.startTime).toFixed(2)}ms]`;
  if (error) {
    logger.error(msg, ContainerBootState[state], error);
    containerBootStore.set({ ...existing, state, errorToLog: error });
    return;
  }

  logger.debug(msg, ContainerBootState[state]);
  containerBootStore.set({ ...existing, state, errorToLog: existing.errorToLog });
}

export function waitForBootStepCompleted(step: ContainerBootState) {
  return waitForContainerBootState(step + 1);
}

export function waitForContainerBootState(minState: ContainerBootState) {
  return waitForStoreValue(containerBootStore, (result) => {
    if (result.state === ContainerBootState.ERROR) {
      throw result.errorToLog ?? new Error('Container boot failed');
    }
    return result.state >= minState ? result : null;
  });
}
