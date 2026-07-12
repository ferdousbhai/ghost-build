import { FeedbackButton } from './FeedbackButton';
import { Button } from '@ui/Button';
import { signInWithGoogle } from '~/lib/auth-client';

export function LoggedOutHeaderButtons() {
  return (
    <>
      <FeedbackButton showInMenu={false} />
      <Button
        variant="neutral"
        size="xs"
        onClick={() => {
          void signInWithGoogle();
        }}
      >
        <span>Sign in</span>
      </Button>
    </>
  );
}
