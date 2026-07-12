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
    setTelemetryExtra('sessionId', sessionId ?? undefined);
  }, [sessionId]);

  useEffect(() => {
    setTelemetryExtra('chatId', chatId);
  }, [chatId]);

  useEffect(() => {
    if (!user) {
      setTelemetryUser(undefined);
      setProfile(null);
      return;
    }

    const username = user.name ?? '';
    setTelemetryUser({
      id: user.id,
      username,
      email: user.email ?? undefined,
    });
    setProfile({
      username,
      email: user.email ?? '',
      avatar: user.image ?? '',
      id: user.id ?? '',
    });
  }, [user]);

  return children;
}
