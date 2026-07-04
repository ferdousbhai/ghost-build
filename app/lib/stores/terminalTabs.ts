import { atom } from 'nanostores';

export const APP_SHELL_TAB_INDEX = 0;
export const WORKER_BUILD_TAB_INDEX = 1;

export const activeTerminalTabStore = atom(0);
export const isWorkerBuildTerminalVisibleStore = atom(false);
