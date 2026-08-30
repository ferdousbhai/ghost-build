export type BuilderPreviewStatus = 'idle' | 'queued' | 'building' | 'ready' | 'failed' | 'cancelled';

export type { BuilderPreviewSuccess } from '@ghostbuild/user-workspace-runtime/protocol';
import type { BuilderPreviewSuccess } from '@ghostbuild/user-workspace-runtime/protocol';

export type BuilderPreviewState = {
  status: BuilderPreviewStatus;
  pendingId: string | null;
  /** The workspace revision the pending publication is bound to, or the last one that published. */
  workspaceRevision: number | null;
  /** The visible Worker version no longer matches the current durable workspace revision. */
  stale: boolean;
  updatedAt: string;
  error: string | null;
  /**
   * The last Worker version that published successfully. It stays visible through a later failed
   * or cancelled publication, because the version itself is immutable and still serving.
   */
  published: BuilderPreviewSuccess | null;
};

export function idleBuilderPreviewState(): BuilderPreviewState {
  return {
    status: 'idle',
    pendingId: null,
    workspaceRevision: null,
    stale: false,
    updatedAt: new Date().toISOString(),
    error: null,
    published: null,
  };
}

export function previewStateForWorkspace(
  state: BuilderPreviewState,
  currentWorkspaceRevision: number,
  updatedAt = new Date().toISOString(),
): BuilderPreviewState {
  return {
    ...state,
    stale: isPreviewStale(state.published, currentWorkspaceRevision),
    updatedAt,
  };
}

export function isPreviewStale(published: BuilderPreviewSuccess | null, currentWorkspaceRevision: number): boolean {
  return published !== null && published.workspaceRevision !== currentWorkspaceRevision;
}

export function failedBuilderPreviewState(
  state: BuilderPreviewState,
  currentWorkspaceRevision: number,
  error: string,
  updatedAt = new Date().toISOString(),
): BuilderPreviewState {
  return {
    ...previewStateForWorkspace(state, currentWorkspaceRevision, updatedAt),
    status: 'failed',
    pendingId: null,
    error,
  };
}
