import { useEffect } from 'react';
import { Button } from '@ui/Button';
import { captureProductEvent } from '~/lib/telemetry.client';
import type { PreviewPresentation } from '~/lib/common/preview-presentation';
import { previewOriginWorkspaceRevision } from '~/agents/builder-preview-types';

export const PREVIEW_SANDBOX = 'allow-forms allow-modals allow-popups allow-same-origin allow-scripts';

export function Preview({
  presentation,
  reloadKey,
  requesting,
  onRequest,
  error,
}: {
  presentation: PreviewPresentation;
  reloadKey: number;
  requesting: boolean;
  onRequest: () => void;
  error: string | null;
}) {
  const { preview, previewUrl, status } = presentation;

  useEffect(() => {
    if (status === 'ready' && preview) {
      void captureProductEvent('preview_ready', {
        outcome: 'success',
        previewMode: preview.mode,
        workspaceRevision: previewOriginWorkspaceRevision(preview),
      });
    }
  }, [preview, status]);

  return (
    <div className="flex size-full min-h-0 flex-col bg-bolt-elements-background-depth-1">
      {previewUrl && preview?.mode === 'dev' && (
        // A dev preview reflects unbuilt, unvalidated, live project state. Saying so on the frame
        // is what stops it being read as the verified build the deployment path requires.
        <div
          className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-content-secondary"
          role="status"
        >
          <span className="font-medium">Live dev preview</span>
          <span className="min-w-0 flex-1">
            Hot-reloads every change. Not a production build and not a validated revision.
          </span>
        </div>
      )}
      {previewUrl && preview && status === 'failed' && (
        <div
          className="flex items-center gap-3 border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-content-error"
          role="status"
        >
          <span className="min-w-0 flex-1">{error ?? 'The latest preview failed.'}</span>
          <Button size="xs" variant="neutral" disabled={requesting} onClick={onRequest}>
            Retry
          </Button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {previewUrl && preview ? (
          <iframe
            key={`${preview.id}:${reloadKey}`}
            className="size-full border-0 bg-white"
            src={previewUrl}
            title={
              preview.mode === 'dev'
                ? 'Live dev preview tracking the current project'
                : `Remote preview for durable revision ${preview.workspaceRevision}`
            }
            sandbox={PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
          />
        ) : (
          <PreviewEmpty status={status} error={error} onRequest={onRequest} disabled={requesting} />
        )}
      </div>
    </div>
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
