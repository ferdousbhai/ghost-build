import { createClientOnlyFn } from '@tanstack/react-start';
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';

type MaybeComponent<TProps> = ComponentType<TProps> | undefined;
type EmptyProps = Record<string, never>;

function createClientComponent<TProps extends object>(getComponent: () => MaybeComponent<TProps>) {
  return function ClientComponent(props: TProps) {
    const Component = getComponent();
    if (!Component) {
      return null;
    }
    return (
      <Suspense fallback={null}>
        <Component {...props} />
      </Suspense>
    );
  };
}

export const ClientAppProviders = createClientComponent<{ children: ReactNode }>(
  createClientOnlyFn(() =>
    lazy(() => import('~/components/AppProviders.client').then((mod) => ({ default: mod.AppProviders }))),
  ),
);

export const ClientHeader = createClientComponent<{ hideSidebarIcon?: boolean }>(
  createClientOnlyFn(() =>
    lazy(() => import('~/components/header/Header.client').then((mod) => ({ default: mod.Header }))),
  ),
);

export const ClientHomepage = createClientComponent<EmptyProps>(
  createClientOnlyFn(() =>
    lazy(() => import('~/components/Homepage.client').then((mod) => ({ default: mod.Homepage }))),
  ),
);

export const ClientExistingChat = createClientComponent<{ chatId: string }>(
  createClientOnlyFn(() =>
    lazy(() => import('~/components/ExistingChat.client').then((mod) => ({ default: mod.ExistingChat }))),
  ),
);

export const ClientSettingsContent = createClientComponent<EmptyProps>(
  createClientOnlyFn(() =>
    lazy(() => import('~/components/SettingsContent.client').then((mod) => ({ default: mod.SettingsContent }))),
  ),
);
