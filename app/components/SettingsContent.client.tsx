import { ArrowLeftIcon } from '@radix-ui/react-icons';
import { ThemeCard } from '~/components/settings/ThemeCard';
import { ProfileCard } from '~/components/settings/ProfileCard';
import { Toaster } from '~/components/ui/Toaster';
import { UserProvider } from '~/components/UserProvider';
import { Button } from '@ui/Button';
import { BrandLink } from '~/components/BrandLink';

export function SettingsContent() {
  return (
    <UserProvider>
      <div className="app-page-shell">
        <div className="app-page-container">
          <nav className="app-page-nav" aria-label="Settings navigation">
            <BrandLink />
            <Button href="/" variant="neutral" size="sm" icon={<ArrowLeftIcon aria-hidden />}>
              <span>Back to builder</span>
            </Button>
          </nav>

          <header>
            <p className="app-page-eyebrow">Workspace preferences</p>
            <h1 className="app-page-title">Make Ghostbuild feel like yours.</h1>
            <p className="app-page-lede">
              Manage your account and choose the interface theme you want across the builder.
            </p>
          </header>

          <div className="app-page-content grid gap-5">
            <ProfileCard />
            <ThemeCard />
          </div>
        </div>
        <Toaster />
      </div>
    </UserProvider>
  );
}
