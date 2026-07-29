import { waitForSessionId } from '~/lib/stores/sessionId';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from '~/lib/cloudflare/data-hooks';
import { api } from '~/lib/cloudflare/data-api';
import { toast } from 'sonner';
import { Toaster } from '~/components/ui/Toaster';
import { GhostbuildAuthProvider, useGhostbuildAuth } from '~/components/chat/GhostbuildAuthWrapper';
import { Loading } from '~/components/Loading';
import { Button } from '@ui/Button';
import { BrandLink } from '~/components/BrandLink';
import { Sheet } from '@ui/Sheet';
import { signInWithCloudflare } from '~/lib/auth-client';
import { ProjectTitle } from '~/components/ProjectTitle';

export const Route = createFileRoute('/create/$shareCode')({
  head: () => ({
    meta: [
      { title: 'Built with Ghostbuild' },
      {
        name: 'description',
        content: 'Someone shared a project built with Ghostbuild, the full-stack AI coding agent.',
      },
      {
        property: 'og:image',
        content: 'https://ghostbuild.dev/social_preview_share.png',
      },
    ],
  }),
  component: ShareProject,
});

function ShareProject() {
  return (
    <>
      <GhostbuildAuthProvider redirectIfUnauthenticated={false}>
        <ShareProjectContent />
      </GhostbuildAuthProvider>
      <Toaster />
    </>
  );
}

function ShareProjectContent() {
  const { shareCode } = Route.useParams();

  const ghostbuildAuthState = useGhostbuildAuth();

  const cloneChat = useMutation(api.share.clone);
  const getShareDescription = useQuery(api.share.getShareDescription, { code: shareCode });

  const handleCloneChat = async () => {
    try {
      const sessionId = await waitForSessionId('useInitializeChat');
      const { id: chatId } = await cloneChat({ shareCode, sessionId });
      window.location.href = `/chat/${chatId}`;
    } catch (e) {
      toast.error(e instanceof Error ? `Error cloning chat: ${e.message}` : 'Unexpected error cloning chat');
    }
  };

  const handleSignIn = async () => {
    try {
      await signInWithCloudflare();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to connect Cloudflare. Please try again.');
    }
  };

  if (ghostbuildAuthState.kind === 'loading') {
    return (
      <div className="app-page-shell">
        <Loading message="Checking the shared project…" />
      </div>
    );
  }

  if (ghostbuildAuthState.kind !== 'fullyLoggedIn') {
    return (
      <ShareProjectShell>
        <div className="mx-auto max-w-2xl text-center">
          <p className="app-page-eyebrow">Shared Ghostbuild project</p>
          <h1 className="app-page-title mx-auto">Bring this build into your workspace.</h1>
          <p className="app-page-lede mx-auto">
            Sign in to create an editable copy, inspect the generated code, and continue building.
          </p>
        </div>
        <Sheet className="app-card mx-auto mt-8 w-full max-w-lg p-6 sm:p-8">
          <span className="app-status-badge">Account required</span>
          <div className="mt-5">
            <h2 className="app-card-title">Sign in to clone this project</h2>
            <p className="app-card-copy mt-2">
              Ghostbuild will add a private copy to your project history
              {getShareDescription?.description ? (
                <>
                  :{' '}
                  <ProjectTitle className="font-semibold text-content-primary">
                    {getShareDescription.description}
                  </ProjectTitle>
                </>
              ) : (
                '.'
              )}
            </p>
          </div>

          <Button className="mt-6 w-full" size="lg" onClick={() => void handleSignIn()}>
            Connect Cloudflare
          </Button>
        </Sheet>
      </ShareProjectShell>
    );
  }

  return (
    <ShareProjectShell>
      <div className="mx-auto max-w-2xl text-center">
        <p className="app-page-eyebrow">Ready to clone</p>
        <h1 className="app-page-title mx-auto">Make this project yours.</h1>
        <p className="app-page-lede mx-auto">
          Create an editable copy and continue the conversation from your workspace.
        </p>
      </div>
      <Sheet className="app-card mx-auto mt-8 w-full max-w-lg p-6 sm:p-8">
        <span className="app-status-badge">Shared build found</span>
        <div className="mt-5">
          <h2 className="app-card-title">Clone project</h2>
          {getShareDescription?.description && (
            <p className="app-card-copy mt-2">
              <ProjectTitle>{getShareDescription.description}</ProjectTitle>
            </p>
          )}
        </div>

        <Button className="mt-6 w-full" size="lg" onClick={handleCloneChat}>
          Clone into Ghostbuild
        </Button>
      </Sheet>
    </ShareProjectShell>
  );
}

function ShareProjectShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-page-shell">
      <div className="app-page-container">
        <nav className="app-page-nav" aria-label="Shared project navigation">
          <BrandLink />
          <Button href="/" variant="neutral" size="sm">
            <span>Back to builder</span>
          </Button>
        </nav>
        {children}
      </div>
    </div>
  );
}
