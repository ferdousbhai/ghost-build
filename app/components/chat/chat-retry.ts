import { atom } from 'nanostores';

export const MAX_CHAT_RETRIES = 4;
export const CHAT_RETRY_EXPIRY_MS = 60_000;

type ChatRetryState = {
  numFailures: number;
  nextRetry: number;
  lastFailureAt: number | null;
};

export const chatRetryState = atom<ChatRetryState>({
  numFailures: 0,
  nextRetry: Date.now(),
  lastFailureAt: null,
});

export function resetChatRetryState(): void {
  chatRetryState.set({ numFailures: 0, nextRetry: Date.now(), lastFailureAt: null });
}

export function getChatRetryState(now = Date.now()): ReturnType<typeof chatRetryState.get> {
  const current = chatRetryState.get();
  if (current.lastFailureAt !== null && now - current.lastFailureAt >= CHAT_RETRY_EXPIRY_MS) {
    const expiredState = { numFailures: 0, nextRetry: now, lastFailureAt: null };
    chatRetryState.set(expiredState);
    return expiredState;
  }
  return current;
}

export function recordChatFailure(useBackoff: boolean, now = Date.now()): void {
  const current = getChatRetryState(now);
  const delay = useBackoff ? exponentialBackoff(current.numFailures + 1) : 0;
  chatRetryState.set({
    numFailures: current.numFailures + 1,
    nextRetry: now + delay,
    lastFailureAt: now,
  });
}

function exponentialBackoff(numFailures: number): number {
  return 1000 * Math.pow(2, numFailures) * (Math.random() + 0.5);
}
