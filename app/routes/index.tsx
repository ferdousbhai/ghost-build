import { createFileRoute } from '@tanstack/react-router';
import { ClientHeader, ClientHomepage } from '~/components/ClientRouteComponents';
import { createSocialPageHead } from '~/lib/social-meta';
import { TrustFooter } from '~/components/trust/TrustLinks';

export const Route = createFileRoute('/')({
  head: () => ({
    ...createSocialPageHead({
      title: 'Ghostbuild | Build and ship Cloudflare apps',
      description: 'Build and ship Cloudflare apps with Ghostbuild, the full-stack AI coding agent.',
      path: '/',
      imagePath: '/social-preview-home-v2.png',
      imageAlt: 'Ghostbuild — build and ship Cloudflare apps',
    }),
  }),
  component: Index,
});

// The home page preserves the initial prompt while Cloudflare authentication is established. After
// starting the chat, all global in-memory state is preserved as it switches to
// the chat view. The router stays on this runtime route and masks the published
// URL as `/chat/$id`; reloading that URL uses the existing-chat route below.
// This route is optimized for making the initial experience seamless.
//
// It's critical that going back to the homepage or to other chats use a `<a>`
// tag so all in-memory state is rebuilt from scratch.
function Index() {
  return (
    <div className="flex size-full flex-col bg-bolt-elements-background-depth-1">
      <ClientHeader />
      <ClientHomepage />
      <TrustFooter />
    </div>
  );
}
