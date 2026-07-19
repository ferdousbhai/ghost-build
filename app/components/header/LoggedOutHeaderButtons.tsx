import { FeedbackButton } from './FeedbackButton';
import { Button } from '@ui/Button';
import { signInWithCloudflare } from '~/lib/auth-client';
import { toast } from 'sonner';

export function LoggedOutHeaderButtons() {
  const handleSignIn = async () => {
    try {
      await signInWithCloudflare();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to connect Cloudflare. Please try again.');
    }
  };

  return (
    <>
      <FeedbackButton showInMenu={false} />
      <Button variant="neutral" size="xs" onClick={() => void handleSignIn()}>
        <span>Connect Cloudflare</span>
      </Button>
    </>
  );
}
