export type BuilderPreviewStatus = 'idle' | 'queued' | 'building' | 'ready' | 'failed' | 'cancelled' | 'expired';

export type BuilderPreviewSuccess = {
  id: string;
  url: string;
  workspaceRevision: number;
  snapshotRevision: string;
  readyAt: string;
  expiresAt: string;
};

export type BuilderPreviewState = {
  status: BuilderPreviewStatus;
  pendingId: string | null;
  workspaceRevision: number | null;
  currentWorkspaceRevision: number;
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
    stale: Boolean(successful) && successful!.workspaceRevision !== currentWorkspaceRevision,
    updatedAt,
  };
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
