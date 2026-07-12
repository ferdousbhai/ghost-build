import { atom } from 'nanostores';
import { useStore } from '@nanostores/react';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { waitForStoreValue } from './waitForStore';
import type { Experience } from '~/utils/experienceChooser';

const logger = createScopedLogger('ContainerBootState');

export enum ContainerBootState {
  UNSUPPORTED = -2,
  ERROR = -1,

  STARTING = 0,
  LOADING_SNAPSHOT = 1,
  DOWNLOADING_DEPENDENCIES = 2,
  STARTING_BACKUP = 3,
  READY = 4,
}

type ContainerBootSnapshot = {
  state: ContainerBootState;
  startTime: number;
  errorToLog?: Error;
  unsupportedExperience?: Experience;
};

class UnsupportedRuntimeError extends Error {
  constructor(readonly experience: Experience | undefined) {
    super('This browser cannot run the Ghostbuild app builder.');
    this.name = 'UnsupportedRuntimeError';
  }
}

const containerBootStore = atom<ContainerBootSnapshot>({
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
    containerBootStore.set({ ...existing, state, errorToLog: error, unsupportedExperience: undefined });
    return;
  }

  logger.debug(msg, ContainerBootState[state]);
  containerBootStore.set({ ...existing, state, errorToLog: existing.errorToLog, unsupportedExperience: undefined });
}

export function setUnsupportedContainerBootState(experience: Experience) {
  const existing = containerBootStore.get();
  const msg = `Container boot [${(Date.now() - existing.startTime).toFixed(2)}ms]`;
  logger.warn(msg, ContainerBootState[ContainerBootState.UNSUPPORTED], experience);
  containerBootStore.set({
    ...existing,
    state: ContainerBootState.UNSUPPORTED,
    errorToLog: undefined,
    unsupportedExperience: experience,
  });
}

export function isUnsupportedRuntimeError(error: unknown): error is UnsupportedRuntimeError {
  return error instanceof UnsupportedRuntimeError;
}

export function waitForBootStepCompleted(step: ContainerBootState) {
  return waitForContainerBootState(step + 1);
}

export function waitForContainerBootState(minState: ContainerBootState) {
  return waitForStoreValue(containerBootStore, (result) => {
    if (result.state === ContainerBootState.UNSUPPORTED) {
      throw new UnsupportedRuntimeError(result.unsupportedExperience);
    }
    if (result.state === ContainerBootState.ERROR) {
      throw result.errorToLog ?? new Error('Container boot failed');
    }
    return result.state >= minState ? result : null;
  });
}
