export type BuilderPreviewStatus = 'idle' | 'queued' | 'building' | 'ready' | 'failed' | 'cancelled' | 'expired';

/**
 * Which guarantee a preview carries. Kept as a discriminant rather than a flag so the two shapes
 * cannot be confused: only `production` has a bound source revision, because only `production` is
 * built from one and asserts it. See `user-workspace-runtime/src/dev-preview.ts`.
 */
export type {
  BuilderDevPreview,
  BuilderPreviewMode,
  BuilderPreviewSuccess,
} from '@ghostbuild/user-workspace-runtime/protocol';
import type { BuilderPreviewMode, BuilderPreviewSuccess } from '@ghostbuild/user-workspace-runtime/protocol';

/**
 * A preview of one exact content revision. The workspace revision and the source digest are the
 * checkpoint the container built from and re-asserted before publishing, so this is the shape that
 * may be reasoned about as "what deployment would publish".
 */

/**
 * A Vite dev server tracking live workspace state over HMR.
 *
 * It carries no `snapshotRevision` on purpose: there is no revision it is a preview *of*. It never
 * proves that the project builds, is never a validation receipt, and satisfies nothing deployment
 * depends on — deployment reads validation receipts and the current checkpoint, never a preview.
 * `startedFromWorkspaceRevision` is provenance for the operator, not a binding.
 */

export type BuilderPreviewState = {
  status: BuilderPreviewStatus;
  /** The mode of the preview being built, or of the last one that was. */
  mode: BuilderPreviewMode;
  pendingId: string | null;
  workspaceRevision: number | null;
  currentWorkspaceRevision: number;
  /**
   * The visible preview no longer matches the workspace. Only ever true for a production preview:
   * a dev preview follows the workspace, so "out of date" is not a state it can be in.
   */
  stale: boolean;
  attempt: number;
  requestedAt: string | null;
  startedAt: string | null;
  updatedAt: string;
  error: string | null;
  active: BuilderPreviewSuccess | null;
  lastSuccessful: BuilderPreviewSuccess | null;
};

export function idleBuilderPreviewState(currentWorkspaceRevision: number): BuilderPreviewState {
  return {
    status: 'idle',
    mode: 'production',
    pendingId: null,
    workspaceRevision: null,
    currentWorkspaceRevision,
    stale: false,
    attempt: 0,
    requestedAt: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    error: null,
    active: null,
    lastSuccessful: null,
  };
}

export function previewStateForWorkspace(
  preview: BuilderPreviewState,
  currentWorkspaceRevision: number,
  updatedAt = new Date().toISOString(),
): BuilderPreviewState {
  const successful = preview.active ?? preview.lastSuccessful;
  return {
    ...preview,
    currentWorkspaceRevision,
    stale: isPreviewStale(successful, currentWorkspaceRevision),
    updatedAt,
  };
}

/**
 * A production preview is stale the moment the durable workspace moves past the revision it was
 * built from. A dev preview is projected the change instead of being invalidated by it, so it is
 * never reported stale — reporting it stale would tell the browser to rebuild the very thing that
 * exists to avoid rebuilds.
 */
export function isPreviewStale(preview: BuilderPreviewSuccess | null, currentWorkspaceRevision: number): boolean {
  return preview?.mode === 'production' && preview.workspaceRevision !== currentWorkspaceRevision;
}

/**
 * The workspace revision a preview came from: the revision a production preview is bound to, and
 * merely the revision a dev preview started at. Callers that only want to name a revision in the
 * UI use this; callers that need the guarantee must discriminate on `mode` themselves.
 */
export function previewOriginWorkspaceRevision(preview: BuilderPreviewSuccess): number {
  return preview.mode === 'dev' ? preview.startedFromWorkspaceRevision : preview.workspaceRevision;
}

export function failedBuilderPreviewState(
  preview: BuilderPreviewState,
  currentWorkspaceRevision: number,
  error: string,
  updatedAt = new Date().toISOString(),
): BuilderPreviewState {
  return {
    ...previewStateForWorkspace(preview, currentWorkspaceRevision, updatedAt),
    status: 'failed',
    pendingId: null,
    error,
    active: null,
  };
}
