import { createFileRoute } from '@tanstack/react-router';
import { ClientHeader, ClientHomepage } from '~/components/ClientRouteComponents';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Ghostbuild | Generate Cloudflare full-stack apps' },
      {
        name: 'description',
        content: 'Build Cloudflare Worker apps with Ghostbuild, the full-stack AI coding agent.',
      },
      {
        property: 'og:image',
        content: '/social_preview_index.png',
      },
    ],
    links: [
      {
        rel: 'canonical',
        href: 'https://ghostbuild.dev/',
      },
    ],
  }),
  component: Index,
});

// The home page preserves the initial prompt while Cloudflare authentication is established. After
// starting the chat, all of the globals' in-memory state is preserved as it
// switches to the chat view (we do *not* do a full page reload and go to the
// chat route). This route is optimized for making the initial experience
// really seamless.
//
// It's critical that going back to the homepage or to other chats use a `<a>`
// tag so all in-memory state is rebuilt from scratch.
function Index() {
  return (
    <div className="flex size-full flex-col bg-bolt-elements-background-depth-1">
      <ClientHeader />
      <ClientHomepage />
    </div>
  );
}
