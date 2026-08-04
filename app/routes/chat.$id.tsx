import { createFileRoute } from '@tanstack/react-router';
import { ClientExistingChat, ClientHeader } from '~/components/ClientRouteComponents';
import { createPrivatePageHead } from '~/lib/social-meta';

export const Route = createFileRoute('/chat/$id')({
  head: () => createPrivatePageHead('Project | Ghostbuild', 'Open a private Ghostbuild project workspace.'),
  component: ChatRoute,
});

// This route is *only* used when reloading an existing chat. The flow
// of going to the homepage and typing in a prompt stays mounted on `index.tsx`
// with a masked `/chat/$id` URL, without rendering `ChatRoute` directly.
//
// So, this route is less latency critical the the homepage, and we're
// more comfortable showing spinners to rehydrate the app state.
function ChatRoute() {
  const { id } = Route.useParams();

  return (
    <div className="flex size-full flex-col bg-bolt-elements-background-depth-1">
      <ClientHeader />
      <ClientExistingChat chatId={id} />
    </div>
  );
}
