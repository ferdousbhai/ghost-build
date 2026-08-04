import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    ssr: { nonce: contentSecurityPolicyNonce() },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  });
}

function contentSecurityPolicyNonce(): string {
  if (typeof document !== 'undefined') {
    const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.content;
    if (nonce && /^[0-9a-f-]{36}$/i.test(nonce)) {
      return nonce;
    }
  }
  return crypto.randomUUID();
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
