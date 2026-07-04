import { waitForSessionId } from '~/lib/stores/sessionId';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from '~/lib/cloudflare/data-hooks';
import { api } from '~/lib/cloudflare/data-api';
import { toast } from 'sonner';
import { Toaster } from '~/components/ui/Toaster';
import { GhostbuildAuthProvider, useGhostbuildAuth } from '~/components/chat/GhostbuildAuthWrapper';
import { Loading } from '~/components/Loading';
import { Button } from '@ui/Button';
import { Sheet } from '@ui/Sheet';
import { signInWithGoogle } from '~/lib/auth-client';

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

  if (ghostbuildAuthState.kind === 'loading') {
    return <Loading />;
  }

  if (ghostbuildAuthState.kind !== 'fullyLoggedIn') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6 rounded-xl border bg-white p-8">
          <div className="space-y-2 text-center">
            <h1 className="text-center text-3xl font-bold">Sign in to Ghostbuild</h1>
            <p className="text-base text-gray-500">
              Please sign in to Ghostbuild to clone this project
              {getShareDescription?.description ? (
                <>
                  : <span className="font-bold">{getShareDescription.description}</span>
                </>
              ) : (
                ''
              )}
            </p>
          </div>

          <Button
            onClick={() => {
              void signInWithGoogle();
            }}
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <Sheet className="w-full max-w-md space-y-6 border p-8">
        <div className="space-y-2 text-center">
          <h1 className="text-center font-semibold">Clone Project</h1>
          {getShareDescription?.description && <p className="text-base">{getShareDescription.description}</p>}
        </div>

        <Button className="flex w-full items-center justify-center gap-2 px-6 py-3" onClick={handleCloneChat}>
          Clone Project
        </Button>
      </Sheet>
    </div>
  );
}
