import { ArrowLeftIcon } from '@radix-ui/react-icons';
import { ThemeCard } from '~/components/settings/ThemeCard';
import { ProfileCard } from '~/components/settings/ProfileCard';
import { Toaster } from '~/components/ui/Toaster';
import { UserProvider } from '~/components/UserProvider';

export function SettingsContent() {
  return (
    <UserProvider>
      <div className="min-h-screen bg-bolt-elements-background-depth-2">
        <div className="mx-auto max-w-4xl px-4 py-8">
          <div className="mb-8 flex items-center gap-4">
            <a href="/" className="inline-flex" title="Back to Chat">
              <ArrowLeftIcon />
            </a>
            <h1 className="text-content-primary text-3xl font-bold">Settings</h1>
          </div>

          <div className="space-y-6">
            <ProfileCard />
            <ThemeCard />
          </div>
        </div>
        <Toaster />
      </div>
    </UserProvider>
  );
}
