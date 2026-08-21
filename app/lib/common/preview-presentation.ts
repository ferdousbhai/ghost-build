import type {
  BuilderPreviewMode,
  BuilderPreviewState,
  BuilderPreviewStatus,
  BuilderPreviewSuccess,
} from '~/agents/builder-preview-types';
import { previewQuickTunnelUrl } from './preview-url';

export type PreviewPresentation = {
  preview: BuilderPreviewSuccess | null;
  previewUrl: string | null;
  status: BuilderPreviewStatus;
  /** The guarantee the visible preview carries, or the one being built when none is visible yet. */
  mode: BuilderPreviewMode;
  canReload: boolean;
  canUpdate: boolean;
  isUpdatingVisible: boolean;
};

export function previewPresentation(state: BuilderPreviewState, now = Date.now()): PreviewPresentation {
  const candidate = state.active ?? state.lastSuccessful;
  const candidateUrl = candidate ? previewQuickTunnelUrl(candidate.url) : null;
  const preview = candidate && Date.parse(candidate.expiresAt) > now ? candidate : null;
  const previewUrl = preview ? candidateUrl : null;
  const status = previewDisplayStatus(state.status, candidate, now, candidateUrl !== null);
  const updating = status === 'queued' || status === 'building';

  return {
    preview,
    previewUrl,
    status,
    mode: preview?.mode ?? state.mode,
    canReload: previewUrl !== null,
    canUpdate: state.stale && previewUrl !== null && !updating && status !== 'failed',
    isUpdatingVisible: previewUrl !== null && updating,
  };
}

export function previewDisplayStatus(
  status: BuilderPreviewStatus,
  candidate: { expiresAt: string } | null,
  now = Date.now(),
  hasValidPreviewUrl = true,
): BuilderPreviewStatus {
  const expired = candidate && Date.parse(candidate.expiresAt) <= now;
  if (expired && status !== 'failed' && status !== 'queued' && status !== 'building') {
    return 'expired';
  }
  if (candidate && !hasValidPreviewUrl && status !== 'queued' && status !== 'building') {
    return 'failed';
  }
  return status;
}
