import { FeedbackButton } from './FeedbackButton';
import { Button } from '@ui/Button';
import { signInWithCloudflare } from '~/lib/auth-client';

export function LoggedOutHeaderButtons() {
  return (
    <>
      <FeedbackButton showInMenu={false} />
      <Button
        variant="neutral"
        size="xs"
        onClick={() => {
          void signInWithCloudflare();
        }}
      >
        <span>Connect Cloudflare</span>
      </Button>
    </>
  );
}
