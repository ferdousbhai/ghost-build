import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import appCss from '../styles.css?url'

const appUrl = 'https://ghostbuild.dev'
const appDescription =
  'GhostBuild is a Cloudflare-native coding agent that turns product ideas into deployed Workers applications.'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'GhostBuild | Cloudflare web app builder',
      },
      {
        name: 'description',
        content: appDescription,
      },
      {
        property: 'og:title',
        content: 'GhostBuild',
      },
      {
        property: 'og:description',
        content: appDescription,
      },
      {
        property: 'og:url',
        content: appUrl,
      },
      {
        property: 'og:site_name',
        content: 'GhostBuild',
      },
      {
        name: 'twitter:card',
        content: 'summary',
      },
      {
        name: 'twitter:title',
        content: 'GhostBuild',
      },
      {
        name: 'twitter:description',
        content: appDescription,
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'canonical',
        href: appUrl,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
