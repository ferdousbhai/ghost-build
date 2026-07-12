export const GUEST_SESSION_COOKIE = 'ghostbuild_guest_session';
export const GUEST_SESSION_ID_PATTERN =
  /^guest_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const GUEST_SESSION_STORAGE_KEY = 'ghostbuild.guestSessionId';
const GUEST_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function isGuestSessionId(value: string | null | undefined): value is string {
  return typeof value === 'string' && GUEST_SESSION_ID_PATTERN.test(value);
}

export function getGuestSessionIdFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName !== GUEST_SESSION_COOKIE) {
      continue;
    }

    const value = safeDecodeURIComponent(rawValue.join('='));
    return isGuestSessionId(value) ? value : null;
  }

  return null;
}

export function getOrCreateGuestSessionId() {
  const existing = getStoredGuestSessionId();
  if (existing) {
    persistGuestSessionId(existing);
    return existing;
  }

  const sessionId = `guest_${crypto.randomUUID()}`;
  persistGuestSessionId(sessionId);
  return sessionId;
}

export function getStoredGuestSessionId() {
  if (typeof window === 'undefined') {
    return null;
  }

  const localStorageSessionId = safeLocalStorageGet(GUEST_SESSION_STORAGE_KEY);
  if (isGuestSessionId(localStorageSessionId)) {
    return localStorageSessionId;
  }

  const cookieSessionId = getGuestSessionIdFromCookie(document.cookie);
  if (cookieSessionId) {
    return cookieSessionId;
  }

  return null;
}

function persistGuestSessionId(sessionId: string) {
  if (typeof window === 'undefined') {
    return;
  }

  safeLocalStorageSet(GUEST_SESSION_STORAGE_KEY, sessionId);

  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${GUEST_SESSION_COOKIE}=${encodeURIComponent(
    sessionId,
  )}; Max-Age=${GUEST_SESSION_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeLocalStorageGet(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The cookie is enough to keep the guest session working when storage is unavailable.
  }
}
