import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@ui/Button';
import { TextInput } from '@ui/TextInput';
import { ACCOUNT_DELETION_CONFIRMATION } from '~/lib/account-data';
import { createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';
import { disposeAccountLocalReplicas } from '~/lib/cloudflare/account-local-replica';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';

type DeletionPhase = 'idle' | 'confirming' | 'deleting' | 'reauthenticate' | 'deleted';

export function AccountDataCard() {
  const [phase, setPhase] = useState<DeletionPhase>('idle');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmation.trim() === ACCOUNT_DELETION_CONFIRMATION && acknowledged;

  const requestDeletion = async () => {
    setPhase('deleting');
    setError(null);
    try {
      const response = await fetch('/api/account/delete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: confirmation.trim(),
          acknowledgeCloudflareResourcesRetained: acknowledged,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        code?: string;
        error?: string;
        cloudflareAuthorizationRevoked?: boolean;
      } | null;
      if (!response.ok) {
        setPhase(payload?.code === 'reauthentication_required' ? 'reauthenticate' : 'confirming');
        setError(payload?.code === 'reauthentication_required' ? null : (payload?.error ?? 'Unable to delete.'));
        return;
      }
      await disposeAccountLocalReplicas();
      resetUserRuntimeSession();
      setRevoked(payload?.cloudflareAuthorizationRevoked === true);
      setPhase('deleted');
    } catch {
      setPhase('confirming');
      setError('Unable to reach Ghostbuild. Check your connection and try again.');
    }
  };

  const reauthenticate = async () => {
    setError(null);
    try {
      await signInWithCloudflare(createCloudflareReturnURL(window.location.href));
    } catch (authorizationError) {
      setError(authorizationError instanceof Error ? authorizationError.message : 'Unable to reconnect Cloudflare.');
    }
  };

  return (
    <section id="your-data" className="app-card w-full p-5 sm:p-6" aria-labelledby="account-data-heading">
      <h2 id="account-data-heading" className="app-card-title">
        Your data
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-content-secondary">
        Ghostbuild’s own database holds your Cloudflare identity and email, your sign-in sessions, your encrypted
        Cloudflare credentials and granted scopes, and the address of your workspace runtime. Your chats, project files,
        deployment records, and every Worker, D1 database, R2 bucket, KV namespace, Container, Durable Object, and Agent
        Ghostbuild created live in your own Cloudflare account, not here. See the{' '}
        <Link to="/privacy">Privacy notice</Link> for the full inventory.
      </p>

      <h3 className="mt-5 text-sm font-medium text-content-primary">Download your project source</h3>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        Open a project and choose <strong>Download code</strong> in the project header to save a ZIP of its files. Local
        secret files are excluded. There is no account-wide export, so download each project you want to keep. Chats,
        deployment history, and generated infrastructure remain readable in your Cloudflare account.
      </p>

      <h3 className="mt-5 text-sm font-medium text-content-primary">Clear this browser</h3>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        Logging out disposes this browser’s account-local project replica. To remove everything Ghostbuild kept on this
        device, clear site data for this site in your browser settings. That removes the <code>ghostbuild_session</code>{' '}
        cookie, the <code>ghostbuild_theme</code> and <code>ghostbuild_builder_model</code> preferences, the telemetry
        preference, tab-scoped session state, and the OPFS database holding cached chats and workspace files. Repeat
        this in every browser and profile you have used; no server-side request can reach them.
      </p>

      <h3 className="mt-5 text-sm font-medium text-content-primary">Ask for a copy or an erasure</h3>
      <p className="mt-1 max-w-2xl text-sm text-content-secondary">
        For an access, portability, correction, or erasure request that this page does not cover, start on{' '}
        <Link to="/support">Support</Link> with only the request type and your GitHub handle. Do not put account details
        or other private information in the public issue.
      </p>

      <h3 className="mt-6 text-sm font-medium text-content-primary">Delete your Ghostbuild account data</h3>
      {phase === 'deleted' ? (
        <div className="mt-2 max-w-2xl text-sm text-content-secondary" role="status">
          <p>
            Ghostbuild erased your account identity, sessions, encrypted credentials, connection metadata, and runtime
            address from its own database.
          </p>
          <p className="mt-2">
            {revoked
              ? 'Cloudflare confirmed that Ghostbuild’s authorization was revoked.'
              : 'Cloudflare did not confirm the revocation. Remove the Ghostbuild authorization yourself in your Cloudflare account under Manage Account → Authorized Apps.'}
          </p>
          <p className="mt-2">
            Resources Ghostbuild deployed are still in your Cloudflare account and still billed to it. Clear this
            browser’s site data to finish removing the local copies.
          </p>
          <p className="mt-3">
            <a className="underline" href="/">
              Return to Ghostbuild
            </a>
          </p>
        </div>
      ) : (
        <>
          <p className="mt-2 max-w-2xl text-sm text-content-secondary">
            This erases your account identity, sign-in sessions, encrypted Cloudflare credentials, connection metadata
            and granted scopes, and your runtime address from Ghostbuild’s database, and asks Cloudflare to revoke
            Ghostbuild’s authorization. It cannot be undone.
          </p>
          <p className="mt-2 max-w-2xl text-sm text-content-secondary">
            It does <strong>not</strong> delete anything inside your Cloudflare account. Workers, D1 databases, R2
            buckets, KV namespaces, Containers, Durable Objects, and Agents that Ghostbuild deployed stay exactly where
            they are, keep serving traffic, keep costing money, and remain yours to remove. It does not clear this
            browser, and signing in again creates a new, empty Ghostbuild account.
          </p>
          <p className="mt-2 max-w-2xl text-sm text-content-secondary">
            To remove a deployed app, delete its project first. Deleting a project reclaims the Cloudflare resources
            Ghostbuild provisioned for it. Once this account is deleted the authorization is gone, so Ghostbuild can no
            longer reclaim anything on your behalf.
          </p>
          {phase === 'idle' ? (
            <Button className="mt-3" size="sm" variant="danger" onClick={() => setPhase('confirming')}>
              Delete my Ghostbuild account data
            </Button>
          ) : (
            <div className="mt-3 grid max-w-2xl gap-3">
              <label className="flex items-start gap-2 text-sm text-content-secondary">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  I understand this is irreversible and that my deployed Cloudflare resources are retained and remain my
                  responsibility.
                </span>
              </label>
              <label className="grid gap-1 text-sm text-content-secondary">
                <span>
                  Type <code>{ACCOUNT_DELETION_CONFIRMATION}</code> to confirm.
                </span>
                <TextInput
                  value={confirmation}
                  autoComplete="off"
                  aria-label="Deletion confirmation phrase"
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              {phase === 'reauthenticate' ? (
                <div role="status" className="text-sm text-content-secondary">
                  <p>Confirm it is you in Cloudflare, then return here and delete again.</p>
                  <Button className="mt-2" size="sm" variant="neutral" onClick={() => void reauthenticate()}>
                    Reconnect Cloudflare
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={phase === 'deleting'}
                    disabled={!confirmed || phase === 'deleting'}
                    onClick={() => void requestDeletion()}
                  >
                    Permanently delete
                  </Button>
                  <Button size="sm" variant="neutral" disabled={phase === 'deleting'} onClick={() => setPhase('idle')}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {error ? (
        <p className="mt-3 text-sm text-bolt-elements-icon-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
