import { useStore } from '@nanostores/react';
import { ReloadIcon } from '@radix-ui/react-icons';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { IconButton } from '~/components/ui/IconButton';
import { Button } from '@ui/Button';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { classNames } from '~/utils/classNames';
import { captureProductEvent } from '~/lib/telemetry.client';
import { previewQuickTunnelUrl } from '~/lib/common/preview-url';

export const PREVIEW_SANDBOX = 'allow-forms allow-modals allow-popups allow-same-origin allow-scripts';

export function Preview() {
  const state = useStore(workbenchStore.previewState);
  const [reloadKey, setReloadKey] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const [, setExpirationTick] = useState(0);
  const candidate = state.active ?? state.lastSuccessful;
  const now = Date.now();
  const preview = candidate && Date.parse(candidate.expiresAt) > now ? candidate : null;
  const candidateUrl = candidate ? previewQuickTunnelUrl(candidate.url) : null;
  const previewUrl = preview ? candidateUrl : null;
  const status = previewDisplayStatus(state.status, candidate, now, candidateUrl !== null);
  const canRetry = state.status === 'failed' || (state.stale && status !== 'queued' && status !== 'building');

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

  useEffect(() => {
    if (status === 'ready' && preview) {
      void captureProductEvent('preview_ready', {
        outcome: 'success',
        workspaceRevision: preview.workspaceRevision,
      });
    }
  }, [preview, status]);

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
          Revision {preview?.workspaceRevision ?? state.workspaceRevision ?? state.currentWorkspaceRevision}
        </div>
        <IconButton
          icon={<ReloadIcon />}
          title="Reload preview frame"
          disabled={!previewUrl}
          onClick={() => setReloadKey((value) => value + 1)}
        />
        {preview && canRetry && (
          <Button size="xs" variant="neutral" disabled={requesting} onClick={requestPreview}>
            Retry
          </Button>
        )}
      </div>

      {preview && status === 'failed' && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-content-error" role="status">
          {state.error ?? 'The latest preview failed.'}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {previewUrl && preview ? (
          <iframe
            key={`${preview.id}:${reloadKey}`}
            className="size-full border-0 bg-white"
            src={previewUrl}
            title={`Remote preview for durable revision ${preview.workspaceRevision}`}
            sandbox={PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
          />
        ) : (
          <PreviewEmpty
            status={status}
            error={state.error}
            onRequest={() => void requestPreview()}
            disabled={requesting}
          />
        )}
      </div>
    </div>
  );
}

export function previewDisplayStatus(
  status: string,
  candidate: { expiresAt: string } | null,
  now = Date.now(),
  hasValidPreviewUrl = true,
): string {
  const expired = candidate && Date.parse(candidate.expiresAt) <= now;
  if (expired && status !== 'failed' && status !== 'queued' && status !== 'building') {
    return 'expired';
  }
  if (candidate && !hasValidPreviewUrl && status !== 'queued' && status !== 'building') {
    return 'failed';
  }
  return status;
}

export const previewFrameUrl = previewQuickTunnelUrl;

function PreviewBadge({ status, stale }: { status: string; stale: boolean }) {
  const label = stale && status === 'ready' ? 'updating' : previewStatusLabel(status);
  return (
    <span
      className={classNames('rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide', {
        'border-emerald-500/30 bg-emerald-500/10 text-emerald-600': label === 'live',
        'border-amber-500/30 bg-amber-500/10 text-amber-600': label === 'updating',
        'border-red-500/30 bg-red-500/10 text-red-600': label === 'failed' || label === 'expired',
        'border-border-transparent text-content-tertiary': label === 'preview',
      })}
    >
      {label}
    </span>
  );
}

function previewStatusLabel(status: string): string {
  if (status === 'ready') {
    return 'live';
  }
  if (status === 'queued' || status === 'building') {
    return 'updating';
  }
  if (status === 'failed' || status === 'expired') {
    return status;
  }
  return 'preview';
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
  const updating = status === 'queued' || status === 'building';
  const title =
    status === 'failed'
      ? 'Preview failed'
      : status === 'expired'
        ? 'Preview expired'
        : updating
          ? 'Updating preview…'
          : 'No preview yet';
  const message =
    status === 'failed'
      ? error
      : status === 'expired'
        ? 'Build the latest revision.'
        : updating
          ? null
          : 'Build the current revision.';
  return (
    <div className="flex size-full items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <p className="font-medium text-content-primary">{title}</p>
        {message && <p className="mt-2 text-sm text-content-secondary">{message}</p>}
        {!updating && (
          <Button className="mt-4" size="sm" disabled={disabled} onClick={onRequest}>
            {status === 'failed' ? 'Retry' : 'Build preview'}
          </Button>
        )}
      </div>
    </div>
  );
}
