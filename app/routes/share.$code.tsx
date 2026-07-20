import { createFileRoute } from '@tanstack/react-router';
import { Show } from '~/components/Show';

export const Route = createFileRoute('/share/$code')({
  loader: ({ params }) => ({ code: params.code }),
  head: () => ({
    meta: [
      { title: 'Shared Project | Ghostbuild' },
      { name: 'description', content: 'Built with Ghostbuild' },
      { property: 'og:title', content: 'Shared Project' },
      { property: 'og:description', content: 'Built with Ghostbuild' },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Ghostbuild' },
      { property: 'og:image', content: '/social_preview_share.png' },
      { property: 'twitter:card', content: 'summary_large_image' },
      { property: 'twitter:image', content: '/social_preview_share.png' },
    ],
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
