import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { waitForStoreValue } from './waitForStore';

const logger = createScopedLogger('SessionIdStore');

type GhostbuildSessionId = string;

export function useSessionIdOrNullOrLoading(): GhostbuildSessionId | null | undefined {
  return useStore(sessionIdStore);
}

export function useSessionId(): GhostbuildSessionId {
  const sessionId = useStore(sessionIdStore);
  if (sessionId === undefined || sessionId === null) {
    throw new Error('Session ID is not set');
  }
  return sessionId;
}

export async function waitForSessionId(caller?: string): Promise<GhostbuildSessionId> {
  const currentSessionId = sessionIdStore.get();
  if (currentSessionId !== null && currentSessionId !== undefined) {
    return currentSessionId;
  }

  if (caller) {
    logger.debug(`[${caller}] Waiting for session ID...`);
  }

  return waitForStoreValue(sessionIdStore, (sessionId) => sessionId);
}

export const sessionIdStore = atom<GhostbuildSessionId | null | undefined>(undefined);

export function getAuthToken(): string | null {
  return sessionIdStore.get() ?? null;
}
