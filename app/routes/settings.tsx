import { GhostbuildAuthProvider } from '~/components/chat/GhostbuildAuthWrapper';
import { createFileRoute } from '@tanstack/react-router';
import { ClientSettingsContent } from '~/components/ClientRouteComponents';

export const Route = createFileRoute('/settings')({
  head: () => ({
    meta: [{ title: 'Settings | Ghostbuild' }],
  }),
  component: Settings,
});

function Settings() {
  return (
    <GhostbuildAuthProvider redirectIfUnauthenticated={true}>
      <ClientSettingsContent />
    </GhostbuildAuthProvider>
  );
}
