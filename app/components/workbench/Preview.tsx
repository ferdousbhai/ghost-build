import { useStore } from '@nanostores/react';
import { ReloadIcon } from '@radix-ui/react-icons';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { IconButton } from '~/components/ui/IconButton';
import { Button } from '@ui/Button';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { classNames } from '~/utils/classNames';

export function Preview() {
  const state = useStore(workbenchStore.previewState);
  const [reloadKey, setReloadKey] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const [, setExpirationTick] = useState(0);
  const candidate = state.active ?? state.lastSuccessful;
  const preview = candidate && Date.parse(candidate.expiresAt) > Date.now() ? candidate : null;
  const previewUrl = preview?.url ?? null;
  const expiresAt = preview ? new Date(preview.expiresAt) : null;
  const status =
    candidate && !preview && state.status !== 'queued' && state.status !== 'building' ? 'expired' : state.status;

  useEffect(() => {
    if (!candidate) {
      return undefined;
    }
    const remaining = Date.parse(candidate.expiresAt) - Date.now();
    if (remaining <= 0) {
      return undefined;
    }
    const timeout = setTimeout(() => setExpirationTick((value) => value + 1), Math.min(remaining + 10, 2_147_483_647));
    return () => clearTimeout(timeout);
  }, [candidate]);

  const requestPreview = async () => {
    setRequesting(true);
    try {
      workbenchStore.updatePreview(await workbenchStore.requestPreview());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to queue a remote preview.');
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="flex size-full min-h-0 flex-col bg-bolt-elements-background-depth-1">
      <div className="flex min-h-12 items-center gap-2 border-b border-border-transparent px-3 py-2">
        <PreviewBadge status={status} stale={state.stale} />
        <div className="min-w-0 flex-1 truncate text-xs text-content-secondary" aria-live="polite">
          {preview
            ? `Durable revision ${preview.workspaceRevision}${expiresAt ? ` · expires ${expiresAt.toLocaleTimeString()}` : ''}`
            : `Durable revision ${state.currentWorkspaceRevision}`}
        </div>
        <IconButton
          icon={<ReloadIcon />}
          title="Reload preview frame"
          disabled={!previewUrl}
          onClick={() => setReloadKey((value) => value + 1)}
        />
        <Button
          size="xs"
          variant="neutral"
          disabled={requesting || state.status === 'building'}
          onClick={requestPreview}
        >
          {requesting || state.status === 'queued' ? 'Queued…' : state.stale ? 'Rebuild' : 'Refresh'}
        </Button>
      </div>

      {(state.stale || status === 'failed' || status === 'expired') && (
        <div
          className={classNames('border-b px-4 py-2 text-xs', {
            'border-amber-500/20 bg-amber-500/10 text-content-warning': state.stale || state.status === 'expired',
            'border-red-500/20 bg-red-500/10 text-content-error': status === 'failed',
          })}
          role="status"
        >
          {status === 'failed'
            ? `${state.error ?? 'The latest remote build failed.'}${preview ? ' The last successful preview is still available.' : ''}`
            : status === 'expired'
              ? 'This preview expired. Build a fresh preview from the current durable revision.'
              : `This preview is stale. The project is now at durable revision ${state.currentWorkspaceRevision}.`}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {previewUrl && preview ? (
          <iframe
            key={`${preview.id}:${reloadKey}`}
            className="size-full border-0 bg-white"
            src={previewUrl}
            title={`Remote preview for durable revision ${preview.workspaceRevision}`}
            sandbox="allow-forms allow-modals allow-popups allow-scripts"
            referrerPolicy="no-referrer"
          />
        ) : (
          <PreviewEmpty
            status={state.status}
            error={state.error}
            onRequest={() => void requestPreview()}
            disabled={requesting}
          />
        )}
        {(state.status === 'queued' || state.status === 'building') && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
            <div className="rounded-full border border-border-transparent bg-bolt-elements-background-depth-2/95 px-3 py-1.5 text-xs text-content-secondary shadow-lg backdrop-blur">
              {state.status === 'queued'
                ? 'Preview queued — isolated capacity is bounded.'
                : `Building revision ${state.workspaceRevision ?? state.currentWorkspaceRevision} in an isolated sandbox…`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewBadge({ status, stale }: { status: string; stale: boolean }) {
  const label = stale && status === 'ready' ? 'stale' : status;
  return (
    <span
      className={classNames('rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide', {
        'border-emerald-500/30 bg-emerald-500/10 text-emerald-600': label === 'ready',
        'border-amber-500/30 bg-amber-500/10 text-amber-600':
          label === 'queued' || label === 'building' || label === 'stale',
        'border-red-500/30 bg-red-500/10 text-red-600': label === 'failed' || label === 'expired',
        'border-border-transparent text-content-tertiary': label === 'idle' || label === 'cancelled',
      })}
    >
      {label}
    </span>
  );
}

function PreviewEmpty({
  status,
  error,
  onRequest,
  disabled,
}: {
  status: string;
  error: string | null;
  onRequest: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex size-full items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <p className="font-medium text-content-primary">
          {status === 'failed' ? 'Remote preview build failed' : 'Build a remote preview'}
        </p>
        <p className="mt-2 text-sm text-content-secondary">
          {error ??
            'Ghostbuild will capture the exact durable workspace revision and run it in a short-lived, isolated Cloudflare Sandbox.'}
        </p>
        <Button className="mt-4" size="sm" disabled={disabled} onClick={onRequest}>
          Build preview
        </Button>
      </div>
    </div>
  );
}
