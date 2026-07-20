import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import { signInWithCloudflare } from '~/lib/auth-client';

type ConnectionStatus = {
  connected: boolean;
  status: 'linking' | 'active' | 'revoked' | 'error' | null;
  accountName?: string | null;
  aiBillingEnabled: boolean;
};

export function CloudflareCard() {
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
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
              for generated-app infrastructure{connection.aiBillingEnabled ? ' and builder inference' : ''}.
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
      <p className="mt-3 text-xs text-content-tertiary">
        Workers Paid is never enabled automatically; Ghostbuild asks for separate authorization if the free allocation
        is exhausted.
      </p>
    </section>
  );
}
