import { useEffect } from 'react';
import { setProfile } from '~/lib/stores/profile';
import { authClient } from '~/lib/auth-client';

export function UserProvider({ children }: { children: React.ReactNode }) {
  const { data: authSession } = authClient.useSession();
  const user = authSession?.user ?? null;

  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }

    const username = user.name ?? '';
    setProfile({
      username,
      email: user.email ?? '',
      avatar: user.image ?? '',
      id: user.id ?? '',
    });
  }, [user]);

  return children;
}
