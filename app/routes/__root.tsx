import { useStore } from '@nanostores/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { ErrorDisplay } from '~/components/ErrorComponent';
import { BrandLink } from '~/components/BrandLink';
import { LinkButton } from '~/components/ui/LinkButton';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { themeStore } from '~/lib/stores/theme';
import { stripIndents } from 'ghostbuild-agent/utils/stripIndent';
import globalStyles from '~/styles/index.css?url';

type RootSearch = {
  prefill?: string;
};

const inlineBootstrapCode = stripIndents`
  setGhostbuildTheme();
  installAssetLoadRecovery();

  function setGhostbuildTheme() {
    let theme = localStorage.getItem('ghostbuild_theme');

    if (!theme) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    document.documentElement.setAttribute('class', theme);
  }

  function installAssetLoadRecovery() {
    var recoveryKey = 'ghostbuild:asset-load-recovery';
    window.setTimeout(function clearAssetLoadRecovery() {
      sessionStorage.removeItem(recoveryKey);
    }, 30000);
    window.addEventListener('error', function recoverAssetLoad(event) {
      var target = event.target;
      var source = target instanceof HTMLScriptElement
        ? target.src
        : target instanceof HTMLLinkElement
          ? target.href
          : '';
      if (!source.includes('/assets/')) {
        return;
      }
      var attempts = Number(sessionStorage.getItem(recoveryKey) || '0');
      if (!Number.isFinite(attempts) || attempts >= 3) {
        return;
      }
      attempts += 1;
      sessionStorage.setItem(recoveryKey, String(attempts));
      window.setTimeout(function reloadForCurrentAssets() {
        window.location.reload();
      }, attempts * 500);
    }, true);
  }
`;

const dynamicImportRecoveryKey = 'ghostbuild:dynamic-import-recovery';

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): RootSearch =>
    typeof search.prefill === 'string' ? { prefill: search.prefill } : {},
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Ghostbuild' },
      {
        name: 'description',
        content: 'Build and ship Cloudflare apps with Ghostbuild, the full-stack AI coding agent.',
      },
      { name: 'application-name', content: 'Ghostbuild' },
      { name: 'color-scheme', content: 'light dark' },
      { name: 'theme-color', content: '#18101e' },
    ],
    links: [
      {
        rel: 'icon',
        href: '/ghostbuild-logo.svg',
        type: 'image/svg+xml',
      },
      { rel: 'manifest', href: '/site.webmanifest' },
      { rel: 'stylesheet', href: globalStyles },
    ],
    scripts: [{ children: inlineBootstrapCode }],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFoundComponent,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={themeStore.value}>
      <head>
        <HeadContent />
      </head>
      <body>
        <div id="root" className="size-full">
          {children}
        </div>
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

function Layout({ children }: { children: ReactNode }) {
  const theme = useStore(themeStore);

  useEffect(() => {
    document.documentElement.setAttribute('class', theme);
  }, [theme]);

  useDynamicImportRecovery();

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <QueryClientProvider client={queryClient}>
        <main id="main-content" className="size-full">
          {children}
        </main>
      </QueryClientProvider>
    </>
  );
}

export function RootNotFoundComponent() {
  return (
    <div className="app-page-shell flex min-h-svh items-center px-4 py-10">
      <section className="app-error-card app-card mx-auto" aria-labelledby="not-found-heading">
        <div className="mb-8 flex items-center justify-between gap-4">
          <BrandLink />
          <span className="app-status-badge">404</span>
        </div>
        <h1 id="not-found-heading" className="app-page-title !text-[clamp(34px,6vw,52px)]">
          This page does not exist.
        </h1>
        <div className="mt-7">
          <LinkButton to="/">Back to Ghostbuild</LinkButton>
        </div>
      </section>
    </div>
  );
}

function RootErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  useEffect(() => {
    recoverFromDynamicImportError(error);
  }, [error]);

  if (typeof window !== 'undefined' && isDynamicImportError(error) && !hasRecoveredDynamicImportForCurrentBuild()) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-content-secondary">Refreshing…</div>
    );
  }

  return <ErrorDisplay error={error} resetErrorBoundary={reset} />;
}

function useDynamicImportRecovery() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      if (recoverFromDynamicImportError(event.error ?? event.message)) {
        event.preventDefault();
      }
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (recoverFromDynamicImportError(event.reason)) {
        event.preventDefault();
      }
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);
}

function recoverFromDynamicImportError(error: unknown) {
  if (typeof window === 'undefined' || !isDynamicImportError(error) || hasRecoveredDynamicImportForCurrentBuild()) {
    return false;
  }

  sessionStorage.setItem(dynamicImportRecoveryKey, getDynamicImportRecoveryToken());
  window.location.reload();
  return true;
}

function hasRecoveredDynamicImportForCurrentBuild() {
  return sessionStorage.getItem(dynamicImportRecoveryKey) === getDynamicImportRecoveryToken();
}

function getDynamicImportRecoveryToken() {
  const assetScripts = Array.from(document.scripts)
    .map((script) => script.src)
    .filter((src) => src.includes('/assets/'));

  return assetScripts.join('|') || window.location.href;
}

function isDynamicImportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Importing a module script failed')
  );
}
