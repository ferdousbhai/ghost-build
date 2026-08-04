import { useStore } from '@nanostores/react';
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { ClientAppProviders } from '~/components/ClientRouteComponents';
import { ClientOnly } from '~/components/ClientOnly';
import { ErrorDisplay } from '~/components/ErrorComponent';
import { themeStore } from '~/lib/stores/theme';
import { stripIndents } from 'ghostbuild-agent/utils/stripIndent';
import globalStyles from '~/styles/index.css?url';

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
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Ghostbuild' },
      {
        name: 'description',
        content: 'Build and ship Cloudflare apps with Ghostbuild, the full-stack AI coding agent.',
      },
    ],
    links: [
      {
        rel: 'icon',
        href: '/ghostbuild-logo.svg',
        type: 'image/svg+xml',
      },
      { rel: 'stylesheet', href: globalStyles },
    ],
    scripts: [{ children: inlineBootstrapCode }],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  errorComponent: RootErrorComponent,
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
    <ClientOnly>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <ClientAppProviders>
        <main id="main-content" className="size-full">
          {children}
        </main>
      </ClientAppProviders>
    </ClientOnly>
  );
}

function RootErrorComponent({ error }: { error: unknown }) {
  useEffect(() => {
    recoverFromDynamicImportError(error);
  }, [error]);

  if (typeof window !== 'undefined' && isDynamicImportError(error) && !hasRecoveredDynamicImportForCurrentBuild()) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-content-secondary">Refreshing…</div>
    );
  }

  return <ErrorDisplay error={error} />;
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
