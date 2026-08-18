import { PENDING_SUBMIT_STORAGE_KEY } from '~/utils/constants';

/**
 * A submit that could not run because Cloudflare was not connected yet leaves the prompt it
 * was carrying here, so the connection it triggered can finish the instruction instead of
 * asking for it again. Tab-local and single-use on purpose: it is the intent of one submit,
 * not a standing preference.
 */
export function recordPendingSubmit(prompt: string): void {
  const message = prompt.trim();
  if (!message) {
    return;
  }
  try {
    window.sessionStorage.setItem(PENDING_SUBMIT_STORAGE_KEY, message);
  } catch {
    // Continuation stays best-effort when browser storage is unavailable.
  }
}

/** Reads the pending submit and spends it: an intent may resume a build exactly once. */
export function takePendingSubmit(): string | null {
  try {
    const pending = window.sessionStorage.getItem(PENDING_SUBMIT_STORAGE_KEY);
    window.sessionStorage.removeItem(PENDING_SUBMIT_STORAGE_KEY);
    return pending;
  } catch {
    return null;
  }
}

export function clearPendingSubmit(): void {
  try {
    window.sessionStorage.removeItem(PENDING_SUBMIT_STORAGE_KEY);
  } catch {
    // Browser storage can be unavailable in privacy-restricted contexts.
  }
}
