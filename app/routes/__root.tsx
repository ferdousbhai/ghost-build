import { useStore } from '@nanostores/react';
import { createRootRoute, HeadContent, Outlet, Scripts, ScrollRestoration } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { ClientAppProviders } from '~/components/ClientRouteComponents';
import { ClientOnly } from '~/components/ClientOnly';
import { ErrorDisplay } from '~/components/ErrorComponent';
import { themeStore } from '~/lib/stores/theme';
import { stripIndents } from 'ghostbuild-agent/utils/stripIndent';
import globalStyles from '~/styles/index.css?url';

const inlineThemeCode = stripIndents`
  setGhostbuildTheme();

  function setGhostbuildTheme() {
    let theme = localStorage.getItem('ghostbuild_theme');

    if (!theme) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    document.documentElement.setAttribute('class', theme);
  }
`;

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
        href: '/favicon.svg',
        type: 'image/svg+xml',
      },
      { rel: 'stylesheet', href: globalStyles },
    ],
    scripts: [{ children: inlineThemeCode }],
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
        <ScrollRestoration />
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

  return (
    <ClientOnly>
      <ClientAppProviders>{children}</ClientAppProviders>
    </ClientOnly>
  );
}

function RootErrorComponent({ error }: { error: unknown }) {
  return <ErrorDisplay error={error} />;
}
