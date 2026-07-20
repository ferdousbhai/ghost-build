import { ArrowLeftIcon } from '@radix-ui/react-icons';
import { ProfileCard } from '~/components/settings/ProfileCard';
import { Toaster } from '~/components/ui/Toaster';
import { UserProvider } from '~/components/UserProvider';
import { Button } from '@ui/Button';
import { BrandLink } from '~/components/BrandLink';
import { CloudflareCard } from '~/components/settings/CloudflareCard.client';

export function SettingsContent() {
  return (
    <UserProvider>
      <div className="app-page-shell">
        <div className="app-page-container">
          <nav className="app-page-nav !mb-8" aria-label="Settings navigation">
            <BrandLink />
            <Button href="/" variant="neutral" size="sm" icon={<ArrowLeftIcon aria-hidden />}>
              <span>Back to builder</span>
            </Button>
          </nav>

          <h1 className="sr-only">Settings</h1>

          <div className="app-page-content !mt-0 grid gap-5">
            <ProfileCard />
            <CloudflareCard />
          </div>
        </div>
        <Toaster />
      </div>
    </UserProvider>
  );
}
