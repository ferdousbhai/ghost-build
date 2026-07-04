import { useEffect } from 'react';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { useChatId } from '~/lib/stores/chatId';
import { setProfile } from '~/lib/stores/profile';
import { authClient } from '~/lib/auth-client';
import { setTelemetryExtra, setTelemetryUser } from '~/lib/telemetry.client';

export function UserProvider({ children }: { children: React.ReactNode }) {
  const { data: authSession } = authClient.useSession();
  const user = authSession?.user ?? null;
  const sessionId = useSessionIdOrNullOrLoading();
  const chatId = useChatId();

  useEffect(() => {
    if (sessionId) {
      setTelemetryExtra('sessionId', sessionId);
    }
  }, [sessionId]);

  useEffect(() => {
    setTelemetryExtra('chatId', chatId);
  }, [chatId]);

  useEffect(() => {
    if (!user) {
      return;
    }

    const username = user.name ?? '';
    setTelemetryUser({
      id: sessionId ?? '',
      username,
      email: user.email ?? undefined,
    });
    setProfile({
      username,
      email: user.email ?? '',
      avatar: user.image ?? '',
      id: user.id ?? '',
    });
  }, [user, sessionId]);

  return children;
}
