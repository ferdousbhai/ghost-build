import type { BuilderPreviewState, BuilderPreviewStatus, BuilderPreviewSuccess } from '~/agents/builder-preview-types';
import { previewWorkerUrl } from './preview-url';

export type PreviewPresentation = {
  preview: BuilderPreviewSuccess | null;
  previewUrl: string | null;
  status: BuilderPreviewStatus;
  canReload: boolean;
  canUpdate: boolean;
  isUpdatingVisible: boolean;
};

export function previewPresentation(state: BuilderPreviewState): PreviewPresentation {
  const preview = state.published;
  const previewUrl = preview ? previewWorkerUrl(preview.url) : null;
  const status = previewDisplayStatus(state.status, preview, previewUrl !== null);
  const updating = status === 'queued' || status === 'building';

  return {
    preview,
    previewUrl,
    status,
    canReload: previewUrl !== null,
    canUpdate: state.stale && previewUrl !== null && !updating && status !== 'failed',
    isUpdatingVisible: previewUrl !== null && updating,
  };
}

/** A published version whose URL the browser will not load is reported as a failed preview. */
export function previewDisplayStatus(
  status: BuilderPreviewStatus,
  published: BuilderPreviewSuccess | null,
  hasValidPreviewUrl: boolean,
): BuilderPreviewStatus {
  if (published && !hasValidPreviewUrl && status !== 'queued' && status !== 'building') {
    return 'failed';
  }
  return status;
}
