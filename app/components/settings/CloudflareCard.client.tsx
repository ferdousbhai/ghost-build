import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import { signInWithCloudflare } from '~/lib/auth-client';

type ConnectionStatus = {
  connected: boolean;
  status: 'linking' | 'active' | 'revoked' | 'error' | null;
  accountName?: string | null;
  aiBillingEnabled: boolean;
  workspaceRuntime?: {
    status: 'not_configured' | 'provisioning' | 'ready' | 'error';
    current: boolean;
    lastError: string | null;
  };
};

export function CloudflareCard() {
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [configuringRuntime, setConfiguringRuntime] = useState(false);
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

  const configureWorkspaceRuntime = async () => {
    setConfiguringRuntime(true);
    setError(null);
    try {
      const response = await fetch('/api/cloudflare/workspace-runtime', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const result = (await response.json().catch(() => null)) as {
        status?: 'ready';
        current?: boolean;
        error?: string;
      } | null;
      if (!response.ok || result?.status !== 'ready') {
        throw new Error(result?.error || 'Unable to configure the user-owned workspace runtime.');
      }
      setConnection((current) =>
        current ? { ...current, workspaceRuntime: { status: 'ready', current: true, lastError: null } } : current,
      );
    } catch (runtimeError) {
      setError(runtimeError instanceof Error ? runtimeError.message : 'Unable to configure project storage.');
    } finally {
      setConfiguringRuntime(false);
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
        <>
          <WorkspaceRuntimeSetup
            runtime={connection.workspaceRuntime}
            configuring={configuringRuntime}
            onConfigure={() => void configureWorkspaceRuntime()}
          />
        </>
      ) : null}
      <p className="mt-3 text-xs text-content-tertiary">
        Computer workspaces, Sandboxes, previews, validation, builds, and generated apps run in your Cloudflare account.
        Ghostbuild retains only your identity, encrypted Cloudflare connection metadata, and the user-runtime locator.
        Workers Paid is never enabled automatically; your account must already support Containers.
      </p>
    </section>
  );
}

function WorkspaceRuntimeSetup({
  runtime,
  configuring,
  onConfigure,
}: {
  runtime: ConnectionStatus['workspaceRuntime'];
  configuring: boolean;
  onConfigure: () => void;
}) {
  if (runtime?.status === 'ready' && runtime.current) {
    return (
      <div className="mt-4 rounded-lg border border-bolt-elements-borderColor px-4 py-3">
        <p className="text-sm font-medium text-content-primary">User-owned project runtime is ready</p>
        <p className="mt-1 text-xs text-content-tertiary">
          Workspace files and execution stay in this connected Cloudflare account.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-lg border border-bolt-elements-borderColor px-4 py-3">
      <p className="text-sm font-medium text-content-primary">Configure user-owned project storage</p>
      <p className="mt-1 text-xs text-content-secondary">
        Create the durable Cloudflare Computer workspace and its isolated execution backends in your account.
      </p>
      {runtime?.lastError ? <p className="mt-2 text-xs text-bolt-elements-icon-error">{runtime.lastError}</p> : null}
      <div className="mt-3">
        <Button size="xs" variant="primary" loading={configuring} onClick={onConfigure}>
          Configure project runtime
        </Button>
      </div>
    </div>
  );
}
