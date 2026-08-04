import { GhostbuildAuthProvider, useGhostbuildAuth } from '~/components/chat/GhostbuildAuthWrapper';
import { createFileRoute, useSearch } from '@tanstack/react-router';
import { ClientSettingsContent } from '~/components/ClientRouteComponents';
import { createPrivatePageHead } from '~/lib/social-meta';
import { Loading } from '~/components/Loading';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';
import {
  CLOUDFLARE_AUTHORIZATION_ERROR_MESSAGE,
  hasCloudflareAuthorizationError,
} from '~/lib/cloudflare/authorization-recovery';

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
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const authorizationError = hasCloudflareAuthorizationError(new URLSearchParams(toStringRecord(search)))
    ? CLOUDFLARE_AUTHORIZATION_ERROR_MESSAGE
    : null;
  return <SettingsRouteView authKind={auth.kind} authorizationError={authorizationError} />;
}

export function SettingsRouteView({
  authKind,
  authorizationError = null,
}: {
  authKind: 'loading' | 'unauthenticated' | 'fullyLoggedIn';
  authorizationError?: string | null;
}) {
  if (authKind === 'loading') {
    return <Loading message="Checking your Cloudflare session…" />;
  }
  if (authKind === 'unauthenticated') {
    return <CloudflareSignInPrompt title="Connect Cloudflare to open settings." initialError={authorizationError} />;
  }
  return <ClientSettingsContent authorizationError={authorizationError} />;
}

function toStringRecord(search: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(search).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
