import { GhostbuildAuthProvider, useGhostbuildAuth } from '~/components/chat/GhostbuildAuthWrapper';
import { createFileRoute } from '@tanstack/react-router';
import { ClientSettingsContent } from '~/components/ClientRouteComponents';
import { createPrivatePageHead } from '~/lib/social-meta';
import { Loading } from '~/components/Loading';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';

export const Route = createFileRoute('/settings')({
  head: () => createPrivatePageHead('Settings | Ghostbuild', 'Manage your Ghostbuild and Cloudflare connection.'),
  component: Settings,
});

function Settings() {
  return (
    <GhostbuildAuthProvider>
      <SettingsRouteContent />
    </GhostbuildAuthProvider>
  );
}

function SettingsRouteContent() {
  const auth = useGhostbuildAuth();
  return <SettingsRouteView authKind={auth.kind} />;
}

export function SettingsRouteView({ authKind }: { authKind: 'loading' | 'unauthenticated' | 'fullyLoggedIn' }) {
  if (authKind === 'loading') {
    return <Loading message="Checking your Cloudflare session…" />;
  }
  if (authKind === 'unauthenticated') {
    return (
      <CloudflareSignInPrompt
        title="Connect Cloudflare to open settings."
        description="Ghostbuild uses your Cloudflare account for the durable project workspace, builds, previews, and approved production deployments."
      />
    );
  }
  return <ClientSettingsContent />;
}
