import { createClientOnlyFn } from '@tanstack/react-start';
import { ClientOnly } from '@tanstack/react-router';
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { BrandLink } from '~/components/BrandLink';
import { Loading } from '~/components/Loading';
import { HOME_AI_DISCLOSURE } from '~/lib/trust';

type MaybeComponent<TProps> = ComponentType<TProps> | undefined;
type EmptyProps = Record<string, never>;

export function createClientComponent<TProps extends object>(
  getComponent: () => MaybeComponent<TProps>,
  renderFallback: (props: TProps) => ReactNode = () => null,
) {
  function HydratedClientComponent(props: TProps) {
    const Component = getComponent();
    const fallback = renderFallback(props);
    if (!Component) {
      return fallback;
    }
    return (
      <Suspense fallback={fallback}>
        <Component {...props} />
      </Suspense>
    );
  }

  return function ClientComponent(props: TProps) {
    const fallback = renderFallback(props);
    return (
      <ClientOnly fallback={fallback}>
        <HydratedClientComponent {...props} />
      </ClientOnly>
    );
  };
}

const LazyAppProviders = lazy(() =>
  import('~/components/AppProviders.client').then((mod) => ({ default: mod.AppProviders })),
);
const LazyHeader = lazy(() => import('~/components/header/Header.client').then((mod) => ({ default: mod.Header })));
const LazyHomepage = lazy(() => import('~/components/Homepage.client').then((mod) => ({ default: mod.Homepage })));
const LazyExistingChat = lazy(() =>
  import('~/components/ExistingChat.client').then((mod) => ({ default: mod.ExistingChat })),
);
const LazySettingsContent = lazy(() =>
  import('~/components/SettingsContent.client').then((mod) => ({ default: mod.SettingsContent })),
);
const LazyTelemetryPreference = lazy(() =>
  import('~/components/trust/TelemetryPreference.client').then((mod) => ({ default: mod.TelemetryPreference })),
);

const getClientAppProviders = createClientOnlyFn(() => LazyAppProviders);
const getClientHeader = createClientOnlyFn(() => LazyHeader);
const getClientHomepage = createClientOnlyFn(() => LazyHomepage);
const getClientExistingChat = createClientOnlyFn(() => LazyExistingChat);
const getClientSettingsContent = createClientOnlyFn(() => LazySettingsContent);
const getClientTelemetryPreference = createClientOnlyFn(() => LazyTelemetryPreference);

export const ClientAppProviders = createClientComponent<{ children: ReactNode }>(
  getClientAppProviders,
  ({ children }) => children,
);

export const ClientHeader = createClientComponent<{ hideSidebarIcon?: boolean }>(getClientHeader, () => (
  <HeaderLoadingFallback />
));

export const ClientHomepage = createClientComponent<EmptyProps>(getClientHomepage, () => <HomepageLoadingFallback />);

export const ClientExistingChat = createClientComponent<{ chatId: string }>(getClientExistingChat, () => (
  <Loading message="Loading project…" />
));

export const ClientSettingsContent = createClientComponent<EmptyProps>(getClientSettingsContent, () => (
  <Loading message="Loading settings…" />
));
export const ClientTelemetryPreference = createClientComponent<EmptyProps>(getClientTelemetryPreference);

function HeaderLoadingFallback() {
  return (
    <header className="ghostbuild-header flex h-[var(--header-height)] items-center border-b px-3 py-1.5 sm:px-5 sm:py-3">
      <BrandLink
        variant="header"
        className="flex items-center gap-2 rounded-md text-content-primary no-underline"
        nameClassName="ghostbuild-brand-name font-display text-lg font-black leading-none text-content-primary"
      />
      <span className="sr-only" role="status">
        Loading navigation…
      </span>
    </header>
  );
}

function HomepageLoadingFallback() {
  return (
    <div className="ghost-home-shell grow p-4 sm:px-6 lg:px-8 lg:py-5">
      <div className="ghost-home-grid">
        <section className="ghost-home-copy min-w-0" aria-labelledby="loading-intro">
          <div>
            <p className="ghost-home-beta">Public beta · Cloudflare Computer preview</p>
            <h1 id="loading-intro" className="ghost-home-title">
              If you can dream it,
              <br />
              <span>the ghost will build it. ✨</span>
            </h1>
            <p className="ghost-home-lede">{HOME_AI_DISCLOSURE}</p>
            <p className="ghost-home-ownership">
              Your Cloudflare account owns the workspace, and every production deploy waits for your approval. Requires
              Workers Paid and Containers.
            </p>
          </div>
          <div
            className="ghost-message-input--home mt-7 flex min-h-16 items-center px-5 text-sm text-content-secondary"
            role="status"
            aria-live="polite"
          >
            Loading the prompt editor…
          </div>
        </section>
      </div>
    </div>
  );
}
