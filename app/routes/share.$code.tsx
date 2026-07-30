import { createFileRoute } from '@tanstack/react-router';
import { Show } from '~/components/Show';
import { createSocialPageHead } from '~/lib/social-meta';

export const Route = createFileRoute('/share/$code')({
  loader: ({ params }) => ({ code: params.code }),
  head: ({ params }) => ({
    ...createSocialPageHead({
      title: 'Shared project | Ghostbuild',
      description: 'Open a Cloudflare app project built with Ghostbuild.',
      path: `/share/${encodeURIComponent(params.code)}`,
      imagePath: '/social-preview-share-v2.png',
      imageAlt: 'A shared project built with Ghostbuild',
    }),
  }),
  component: ShowRoute,
});

function ShowRoute() {
  const { code } = Route.useLoaderData();

  return (
    <div className="flex size-full flex-col bg-bolt-elements-background-depth-1">
      <Show code={code} />
    </div>
  );
}
