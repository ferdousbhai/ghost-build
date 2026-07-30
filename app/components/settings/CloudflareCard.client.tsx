import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import { signInWithCloudflare } from '~/lib/auth-client';

type ConnectionStatus = {
  connected: boolean;
  status: 'linking' | 'active' | 'revoked' | 'error' | null;
  accountName?: string | null;
  aiBillingEnabled: boolean;
  deploymentSecurity?: DeploymentSecurityStatus;
};

export type DeploymentSecurityStatus = {
  state: 'current' | 'action_required' | 'checking' | 'none';
  items: DeploymentSecurityItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

type DeploymentSecurityItem = {
  scope: 'managed' | 'historical';
  state: 'current' | 'upgrade_available' | 'user_action_required' | 'verification_failed' | 'not_applicable';
  deploymentId: string | null;
  productionUrl: string | null;
  checkedAt: number | null;
  workerName: string | null;
  remediation:
    | { kind: 'replace_from_fresh_builder'; builderPath: '/'; manualCleanupRequired: true }
    | { kind: 'reauthorize_cloudflare' }
    | null;
};

export function CloudflareCard() {
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [loadingMoreSecurity, setLoadingMoreSecurity] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    void fetch('/api/cloudflare/connection')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Unable to load Cloudflare connection status.');
        }
        return (await response.json()) as ConnectionStatus;
      })
      .then((status) => {
        if (!canceled) {
          setConnection(status);
        }
      })
      .catch((statusError) => {
        if (!canceled) {
          setError(statusError instanceof Error ? statusError.message : 'Unable to load Cloudflare.');
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, []);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await signInWithCloudflare(window.location.href);
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : 'Unable to connect Cloudflare.');
      setConnecting(false);
    }
  };

  const loadMoreSecurity = async () => {
    const cursor = connection?.deploymentSecurity?.nextCursor;
    if (cursor === null || cursor === undefined) {
      return;
    }
    setLoadingMoreSecurity(true);
    setError(null);
    try {
      const response = await fetch(`/api/cloudflare/connection?deploymentSecurityCursor=${encodeURIComponent(cursor)}`);
      if (!response.ok) {
        throw new Error('Unable to load more deployment security checks.');
      }
      const next = (await response.json()) as ConnectionStatus;
      setConnection((current) => mergeConnectionSecurityPage(current, next));
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'Unable to load deployment security checks.');
    } finally {
      setLoadingMoreSecurity(false);
    }
  };

  return (
    <section id="cloudflare" className="app-card w-full p-5 sm:p-6" aria-labelledby="cloudflare-heading">
      <p className="app-page-eyebrow">Authentication and billing</p>
      <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="cloudflare-heading" className="app-card-title">
            Cloudflare account
          </h2>
          {loading ? (
            <p className="mt-1 text-sm text-content-secondary">Checking connection…</p>
          ) : connection?.connected ? (
            <p className="mt-1 text-sm text-content-secondary">
              Connected{connection.accountName ? ` to ${connection.accountName}` : ''}. Cloudflare bills this account
              for project storage, generated-app infrastructure
              {connection.aiBillingEnabled ? ' and builder inference' : ''}.
            </p>
          ) : (
            <p className="mt-1 max-w-2xl text-sm text-content-secondary">
              Connect your account so Cloudflare bills you directly for production resources and eligible Workers AI
              inference. Ghostbuild remains free.
            </p>
          )}
        </div>
        {!loading ? (
          <Button
            size="sm"
            variant={connection?.connected ? 'neutral' : 'primary'}
            loading={connecting}
            onClick={() => void connect()}
          >
            {connection?.connected ? 'Reauthorize Cloudflare' : 'Connect Cloudflare'}
          </Button>
        ) : null}
      </div>
      {error ? <p className="mt-3 text-sm text-bolt-elements-icon-error">{error}</p> : null}
      {connection?.connected ? (
        <DeploymentSecurityPanel
          status={connection.deploymentSecurity ?? { state: 'checking', items: [], hasMore: false, nextCursor: null }}
          connecting={connecting}
          loadingMore={loadingMoreSecurity}
          onLoadMore={() => void loadMoreSecurity()}
          onReauthorize={() => void connect()}
        />
      ) : null}
      <p className="mt-3 text-xs text-content-tertiary">
        Project backups and oversized workspace files use the managed ghostbuild-user-data R2 bucket in this account.
        Public share images and temporary deployment artifacts remain with Ghostbuild. Workers Paid is never enabled
        automatically.
      </p>
    </section>
  );
}

export function DeploymentSecurityPanel({
  status,
  connecting = false,
  loadingMore = false,
  onLoadMore = () => undefined,
  onReauthorize = () => undefined,
}: {
  status: DeploymentSecurityStatus;
  connecting?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onReauthorize?: () => void;
}) {
  const continuation = status.hasMore ? (
    <div className="mt-3">
      <Button size="xs" variant="ghost" loading={loadingMore} onClick={onLoadMore}>
        Load more deployment checks
      </Button>
    </div>
  ) : null;
  const verifiedCurrentCount = status.items.filter((item) => item.state === 'current').length;
  if (status.state === 'none') {
    return continuation ? (
      <div className="mt-4 rounded-lg border border-bolt-elements-borderColor px-4 py-3">
        <p className="text-sm font-medium text-content-primary">More generated app security checks are available</p>
        {continuation}
      </div>
    ) : null;
  }
  if (status.state === 'checking') {
    return (
      <div className="mt-4 rounded-lg border border-bolt-elements-borderColor px-4 py-3">
        <p className="text-sm font-medium text-content-primary">Checking generated app security…</p>
        {verifiedCurrentCount > 0 ? (
          <p className="mt-1 text-xs text-content-secondary">
            {verifiedCurrentCount} generated {verifiedCurrentCount === 1 ? 'app is' : 'apps are'} verified current on
            this page; additional checks remain.
          </p>
        ) : null}
        <p className="mt-1 text-xs text-content-tertiary">No Cloudflare resources will be changed by this check.</p>
        {continuation}
      </div>
    );
  }
  if (status.state === 'current') {
    return (
      <div className="mt-4 rounded-lg border border-bolt-elements-borderColor px-4 py-3">
        <p className="text-sm font-medium text-content-primary">Generated app security is current</p>
        <p className="mt-1 text-xs text-content-tertiary">
          Ghostbuild verified the active managed deployment baseline.
        </p>
        {continuation}
      </div>
    );
  }

  const actionable = status.items.filter((item) =>
    ['upgrade_available', 'user_action_required', 'verification_failed'].includes(item.state),
  );
  return (
    <div className="mt-4 rounded-lg border border-bolt-elements-borderColor px-4 py-3">
      <p className="text-sm font-medium text-content-primary">Generated apps need your attention</p>
      <p className="mt-1 text-xs text-content-secondary">
        Ghostbuild will never overwrite an existing deployment automatically. Build a replacement from the latest
        template, review and approve its complete plan, verify it, then retire the affected Worker in Cloudflare.
      </p>
      <ul className="mt-3 space-y-3">
        {actionable.map((item, index) => (
          <li
            key={item.deploymentId ?? `${item.scope}-${item.state}-${index}`}
            className="text-xs text-content-secondary"
          >
            {item.workerName ? (
              <p>
                Worker: <code className="font-mono text-content-primary">{item.workerName}</code>
              </p>
            ) : null}
            <p>{deploymentSecurityMessage(item)}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {item.remediation?.kind === 'replace_from_fresh_builder' ? (
                <>
                  <Button href={item.remediation.builderPath} size="xs" variant="neutral">
                    Start secure replacement
                  </Button>
                  <Button
                    href="https://dash.cloudflare.com/"
                    target="_blank"
                    rel="noreferrer"
                    size="xs"
                    variant="ghost"
                  >
                    Cloudflare dashboard
                  </Button>
                </>
              ) : null}
              {item.remediation?.kind === 'reauthorize_cloudflare' ? (
                <Button size="xs" variant="neutral" loading={connecting} onClick={onReauthorize}>
                  Reauthorize Cloudflare
                </Button>
              ) : null}
              {item.productionUrl ? (
                <Button href={item.productionUrl} target="_blank" rel="noreferrer" size="xs" variant="ghost">
                  View deployed app
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {continuation}
    </div>
  );
}

function mergeConnectionSecurityPage(current: ConnectionStatus | null, next: ConnectionStatus): ConnectionStatus {
  const previousSecurity = current?.deploymentSecurity;
  const nextSecurity = next.deploymentSecurity;
  if (!previousSecurity || !nextSecurity) {
    return next;
  }
  const items = new Map<string, DeploymentSecurityItem>();
  for (const item of [...previousSecurity.items, ...nextSecurity.items]) {
    items.set(item.workerName ?? item.deploymentId ?? `${item.scope}:${item.state}:${item.checkedAt}`, item);
  }
  const combinedItems = [...items.values()];
  const state = combinedItems.some((item) =>
    ['upgrade_available', 'user_action_required', 'verification_failed'].includes(item.state),
  )
    ? 'action_required'
    : previousSecurity.state === 'checking' || nextSecurity.state === 'checking'
      ? 'checking'
      : combinedItems.some((item) => item.state === 'current')
        ? 'current'
        : 'none';
  return {
    ...next,
    deploymentSecurity: {
      state,
      items: combinedItems,
      hasMore: nextSecurity.hasMore,
      nextCursor: nextSecurity.nextCursor,
    },
  };
}

function deploymentSecurityMessage(item: DeploymentSecurityItem): string {
  if (item.state === 'upgrade_available') {
    return 'A managed app uses an older security baseline. Create and verify a secure replacement, then retire this deployment in Cloudflare.';
  }
  if (item.state === 'verification_failed') {
    return 'Ghostbuild could not verify this app. Reauthorize Cloudflare, then wait for the next security check.';
  }
  return item.scope === 'historical'
    ? 'A historical app may predate managed security checks. Replace it from the latest template, then retire the old Worker in Cloudflare.'
    : 'A managed app no longer matches its approved security baseline. Replace it and retire the affected Worker in Cloudflare.';
}
