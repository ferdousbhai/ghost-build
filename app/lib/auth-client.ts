import { createClientOnlyFn } from '@tanstack/react-start';
import { useEffect, useSyncExternalStore } from 'react';
import type { CloudflareAuthSession } from '~/lib/.server/auth';
import { disposeAccountLocalReplicas } from '~/lib/cloudflare/account-local-replica';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { captureProductEvent } from '~/lib/telemetry.client';
import { CLOUDFLARE_AUTHORIZATION_ERROR_PARAM } from '~/lib/cloudflare/authorization-recovery';

const captureCloudflareConnectStarted = createClientOnlyFn(() => {
  void captureProductEvent('cloudflare_connect_started');
});

type AuthState = {
  data: CloudflareAuthSession | null;
  isPending: boolean;
};

const listeners = new Set<() => void>();
const serverSnapshot: AuthState = { data: null, isPending: true };
let state: AuthState = serverSnapshot;
let loading: Promise<void> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setState(next: AuthState) {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

async function loadSession() {
  if (loading) {
    return loading;
  }
  loading = fetch('/api/auth/session', { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error('Unable to load the Cloudflare session.');
      }
      setState({ data: (await response.json()) as CloudflareAuthSession | null, isPending: false });
    })
    .catch(() => setState({ data: null, isPending: false }))
    .finally(() => {
      loading = null;
    });
  return loading;
}

export const authClient = {
  useSession() {
    const snapshot = useSyncExternalStore(
      subscribe,
      () => state,
      () => serverSnapshot,
    );
    useEffect(() => {
      void loadSession();
    }, []);
    return snapshot;
  },
};

export async function signInWithCloudflare(callbackURL = window.location.href) {
  captureCloudflareConnectStarted();
  const response = await fetch('/api/cloudflare/connection/start', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callbackURL }),
  });
  const payload = (await response.json().catch(() => null)) as { authorizationUrl?: string; error?: string } | null;
  if (!response.ok || !payload?.authorizationUrl) {
    throw new Error(payload?.error ?? 'Unable to start Cloudflare authorization.');
  }
  window.location.assign(payload.authorizationUrl);
}

export function createCloudflareReturnURL(returnURL = window.location.href, origin = window.location.origin): string {
  const expectedOrigin = new URL(origin).origin;
  try {
    const requested = new URL(returnURL, expectedOrigin);
    if (requested.origin === expectedOrigin && !requested.pathname.startsWith('//')) {
      requested.searchParams.delete(CLOUDFLARE_AUTHORIZATION_ERROR_PARAM);
      if (requested.pathname === '/settings') {
        const continuation = requested.searchParams.get('continue');
        if (continuation && continuation.startsWith('/') && !continuation.startsWith('//')) {
          const target = new URL(continuation, expectedOrigin);
          if (target.origin === expectedOrigin && !target.pathname.startsWith('//')) {
            return target.toString();
          }
        }
        requested.searchParams.delete('continue');
      }
      return requested.toString();
    }
  } catch {
    // Invalid and external destinations return to the public builder.
  }
  return `${expectedOrigin}/`;
}

export async function signOutOfGhostbuild(callbackURL = window.location.origin) {
  const response = await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? 'Unable to sign out of Ghostbuild.');
  }
  setState({ data: null, isPending: false });
  disposeAccountLocalReplicas();
  resetUserRuntimeSession();
  window.location.assign(callbackURL);
}
