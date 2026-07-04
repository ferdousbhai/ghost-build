import { useStore } from '@nanostores/react';
import { lazy, Suspense, useState } from 'react';
import { chatStore } from '~/lib/stores/chatId';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/components/header/ChatDescription.client';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { HamburgerMenuIcon, PersonIcon, GearIcon, ExitIcon } from '@radix-ui/react-icons';
import { LoggedOutHeaderButtons } from './LoggedOutHeaderButtons';
import { profileStore, setProfile } from '~/lib/stores/profile';
import { Menu as MenuComponent, MenuItem as MenuItemComponent } from '@ui/Menu';
import { FeedbackButton } from './FeedbackButton';
import { signOutOfGhostbuild } from '~/lib/auth-client';

const DownloadButton = lazy(() => import('./DownloadButton').then((module) => ({ default: module.DownloadButton })));
const ShareButton = lazy(() => import('./ShareButton').then((module) => ({ default: module.ShareButton })));
const SidebarMenu = lazy(() => import('~/components/sidebar/Menu.client').then((module) => ({ default: module.Menu })));

export function Header({ hideSidebarIcon = false }: { hideSidebarIcon?: boolean }) {
  const chat = useStore(chatStore);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const sessionId = useSessionIdOrNullOrLoading();
  const isLoggedIn = sessionId !== null;
  const showSidebarIcon = !hideSidebarIcon && isLoggedIn;

  const profile = useStore(profileStore);

  const handleLogout = () => {
    setProfile(null);
    void signOutOfGhostbuild();
  };

  const handleSettingsClick = () => {
    window.location.pathname = '/settings';
  };

  return (
    <header className={'flex h-[var(--header-height)] items-center overflow-x-auto overflow-y-hidden border-b p-5'}>
      <div className="text-content-primary z-40 flex cursor-pointer items-center gap-4">
        {showSidebarIcon && (
          <HamburgerMenuIcon
            className="shrink-0"
            data-hamburger-menu
            onClick={(e) => {
              e.stopPropagation();
              setIsMenuOpen(!isMenuOpen);
            }}
          />
        )}
        <a
          href="/"
          aria-label="Ghostbuild home"
          className="text-content-primary hover:text-content-primary flex items-center gap-2 rounded-md no-underline hover:no-underline"
        >
          <img src="/favicon.svg" alt="" className="size-8 shrink-0" />
          <span className="flex flex-col leading-none">
            <span className="text-content-primary text-base font-bold">Ghostbuild</span>
            <span className="text-content-tertiary mt-1 text-xs font-medium">Cloudflare builder</span>
          </span>
        </a>
      </div>
      {chat.started && (
        <span className="text-content-primary flex-1 truncate px-4 text-center">
          <ChatDescription />
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {!isLoggedIn && <LoggedOutHeaderButtons />}

        {chat.started && (
          <>
            <Suspense fallback={null}>
              <DownloadButton />
              <ShareButton />
            </Suspense>
            <div className="mr-1">
              <HeaderActionButtons />
            </div>
          </>
        )}
        {profile && (
          <MenuComponent
            placement="top-start"
            buttonProps={{
              variant: 'neutral',
              title: 'User menu',
              inline: true,
              className: 'rounded-full',
              icon: profile.avatar ? (
                <img
                  src={profile.avatar}
                  className="size-8 min-w-8 rounded-full object-cover"
                  loading="eager"
                  decoding="sync"
                />
              ) : (
                <PersonIcon className="text-content-secondary size-8 min-w-8 rounded-full border" />
              ),
            }}
          >
            <FeedbackButton showInMenu={true} />
            <hr />
            <MenuItemComponent action={handleSettingsClick}>
              <GearIcon className="text-content-secondary" />
              Settings
            </MenuItemComponent>
            <MenuItemComponent action={handleLogout}>
              <ExitIcon className="text-content-secondary" />
              Log out
            </MenuItemComponent>
          </MenuComponent>
        )}
      </div>
      {isMenuOpen && (
        <Suspense fallback={null}>
          <SidebarMenu isOpen onClose={() => setIsMenuOpen(false)} />
        </Suspense>
      )}
    </header>
  );
}
