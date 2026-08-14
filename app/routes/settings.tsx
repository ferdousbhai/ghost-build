import { GhostbuildAuthProvider, useGhostbuildAuth } from '~/components/chat/GhostbuildAuthWrapper';
import { createFileRoute } from '@tanstack/react-router';
import { ClientSettingsContent } from '~/components/ClientRouteComponents';
import { createPrivatePageHead } from '~/lib/social-meta';
import { Loading } from '~/components/Loading';
import { CloudflareSignInPrompt } from '~/components/CloudflareSignInPrompt';
import {
  CLOUDFLARE_AUTHORIZATION_ERROR_MESSAGE,
  CLOUDFLARE_AUTHORIZATION_ERROR_PARAM,
  CLOUDFLARE_AUTHORIZATION_ERROR_VALUE,
} from '~/lib/cloudflare/authorization-recovery';

type SettingsSearch = {
  cloudflare_authorization?: string;
};

export const Route = createFileRoute('/settings')({
  validateSearch: (search: Record<string, unknown>): SettingsSearch =>
    typeof search[CLOUDFLARE_AUTHORIZATION_ERROR_PARAM] === 'string'
      ? { cloudflare_authorization: search[CLOUDFLARE_AUTHORIZATION_ERROR_PARAM] }
      : {},
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
  const search = Route.useSearch();
  const authorizationError =
    search.cloudflare_authorization === CLOUDFLARE_AUTHORIZATION_ERROR_VALUE
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
