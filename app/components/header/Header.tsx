import { useStore } from '@nanostores/react';
import { lazy, Suspense, useState } from 'react';
import { chatStore } from '~/lib/stores/chatId';
import { ChatDescription } from '~/components/header/ChatDescription.client';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { HamburgerMenuIcon, PersonIcon, GearIcon, ExitIcon, Share2Icon } from '@radix-ui/react-icons';
import { LoggedOutHeaderButtons } from './LoggedOutHeaderButtons';
import { profileStore, setProfile } from '~/lib/stores/profile';
import { Menu as MenuComponent, MenuItem as MenuItemComponent } from '@ui/Menu';
import { FeedbackButton } from './FeedbackButton';
import { signInWithCloudflare, signOutOfGhostbuild } from '~/lib/auth-client';
import { BrandLink } from '~/components/BrandLink';
import { Button } from '@ui/Button';
import { ThemeSwitch } from '~/components/ui/ThemeSwitch';
import { toast } from 'sonner';

const DownloadButton = lazy(() => import('./DownloadButton').then((module) => ({ default: module.DownloadButton })));
const ShareButton = lazy(() => import('./ShareButton').then((module) => ({ default: module.ShareButton })));
const SidebarMenu = lazy(() => import('~/components/sidebar/Menu.client').then((module) => ({ default: module.Menu })));
const HeaderActionButtons = lazy(() =>
  import('./HeaderActionButtons.client').then((module) => ({ default: module.HeaderActionButtons })),
);

export function Header({ hideSidebarIcon = false }: { hideSidebarIcon?: boolean }) {
  const chat = useStore(chatStore);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const sessionId = useSessionIdOrNullOrLoading();
  const isAccountSession = typeof sessionId === 'string';
  const showSidebarIcon = !hideSidebarIcon && isAccountSession;

  const profile = useStore(profileStore);

  const handleLogout = async () => {
    try {
      await signOutOfGhostbuild();
      setProfile(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to sign out. Please try again.');
    }
  };

  const handleSignIn = async () => {
    try {
      await signInWithCloudflare();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to connect Cloudflare. Please try again.');
    }
  };

  const handleSettingsClick = () => {
    window.location.pathname = '/settings';
  };

  return (
    <>
      <header
        className="ghostbuild-header box-border flex h-[var(--header-height)] items-center overflow-x-auto overflow-y-hidden border-b px-5 py-3"
        data-chat-started={chat.started}
      >
        <div className="z-40 flex items-center gap-3 text-content-primary">
          {showSidebarIcon && (
            <button
              type="button"
              className="ghostbuild-header__menu-button"
              data-hamburger-menu
              aria-label={isMenuOpen ? 'Close project menu' : 'Open project menu'}
              aria-expanded={isMenuOpen}
              aria-controls="project-sidebar"
              onClick={(e) => {
                e.stopPropagation();
                setIsMenuOpen((open) => !open);
              }}
            >
              <HamburgerMenuIcon aria-hidden />
            </button>
          )}
          <BrandLink
            variant="header"
            className="flex items-center gap-2 rounded-md text-content-primary no-underline hover:text-content-primary hover:no-underline"
            nameClassName="ghostbuild-brand-name font-display text-lg font-black leading-none text-content-primary"
          />
        </div>
        {chat.started && (
          <span className="hidden flex-1 truncate px-4 text-center text-content-primary lg:block">
            <ChatDescription />
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!isAccountSession && <LoggedOutHeaderButtons />}

          {chat.started && (
            <>
              <Suspense fallback={null}>
                <DownloadButton />
                {isAccountSession ? (
                  <ShareButton />
                ) : (
                  <Button
                    variant="neutral"
                    size="xs"
                    title="Connect Cloudflare to share"
                    aria-label="Connect Cloudflare to share"
                    onClick={() => void handleSignIn()}
                  >
                    <Share2Icon />
                    <span className="hidden md:inline">Share</span>
                  </Button>
                )}
              </Suspense>
              <Suspense fallback={null}>
                <div className="mr-1">
                  <HeaderActionButtons />
                </div>
              </Suspense>
            </>
          )}
          <ThemeSwitch />
          {profile && (
            <>
              <div className="hidden items-center gap-1 lg:flex">
                <FeedbackButton showInMenu={false} variant="ghost" className="flex" />
                <Button variant="ghost" size="xs" onClick={handleSettingsClick} icon={<GearIcon />}>
                  Settings
                </Button>
                <Button variant="ghost" size="xs" onClick={() => void handleLogout()} icon={<ExitIcon />}>
                  Log out
                </Button>
                <span
                  className="ml-1 inline-flex rounded-full ring-1 ring-bolt-elements-borderColor"
                  title={profile.username ?? 'Signed-in user'}
                >
                  <ProfileAvatar avatar={profile.avatar} username={profile.username} />
                </span>
              </div>
              <div className="lg:hidden">
                <MenuComponent
                  buttonProps={{
                    variant: 'neutral',
                    title: 'User menu',
                    inline: true,
                    className: 'rounded-full',
                    icon: <ProfileAvatar avatar={profile.avatar} username={profile.username} />,
                  }}
                >
                  <FeedbackButton showInMenu={true} />
                  <hr className="my-1 border-bolt-elements-borderColor" />
                  <MenuItemComponent action={handleSettingsClick}>
                    <GearIcon className="text-content-secondary" />
                    Settings
                  </MenuItemComponent>
                  <MenuItemComponent action={() => void handleLogout()}>
                    <ExitIcon className="text-content-secondary" />
                    Log out
                  </MenuItemComponent>
                </MenuComponent>
              </div>
            </>
          )}
        </div>
      </header>
      {isMenuOpen && (
        <Suspense fallback={null}>
          <SidebarMenu isOpen onClose={() => setIsMenuOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

function ProfileAvatar({ avatar, username }: { avatar?: string | null; username?: string | null }) {
  return avatar ? (
    <img
      src={avatar}
      alt={username ? `${username} profile` : 'User profile'}
      className="size-8 min-w-8 rounded-full object-cover"
      loading="eager"
      decoding="sync"
    />
  ) : (
    <PersonIcon className="size-8 min-w-8 rounded-full border text-content-secondary" />
  );
}
