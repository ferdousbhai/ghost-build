import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { waitForStoreValue } from './waitForStore';

const logger = createScopedLogger('UserIdStore');

type GhostbuildUserId = string;

export function useUserIdOrNullOrLoading(): GhostbuildUserId | null | undefined {
  return useStore(userIdStore);
}

export async function waitForUserId(caller?: string): Promise<GhostbuildUserId> {
  const currentUserId = userIdStore.get();
  if (currentUserId !== null && currentUserId !== undefined) {
    return currentUserId;
  }

  if (caller) {
    logger.debug(`[${caller}] Waiting for user ID...`);
  }

  return waitForStoreValue(userIdStore, (userId) => userId);
}

export const userIdStore = atom<GhostbuildUserId | null | undefined>(undefined);

export function isAuthenticated(): boolean {
  return typeof userIdStore.get() === 'string';
}
