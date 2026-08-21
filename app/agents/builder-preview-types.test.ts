import { describe, expect, it } from 'vitest';
import {
  failedBuilderPreviewState,
  idleBuilderPreviewState,
  isPreviewStale,
  previewOriginWorkspaceRevision,
  previewStateForWorkspace,
  type BuilderDevPreview,
  type BuilderPreviewSuccess,
} from './builder-preview-types';

const successful: BuilderPreviewSuccess = {
  mode: 'production',
  id: 'preview-a',
  url: '/api/previews/id/token/',
  workspaceRevision: 4,
  snapshotRevision: 'snapshot-sha',
  readyAt: '2026-07-30T10:00:00.000Z',
  expiresAt: '2026-07-30T10:15:00.000Z',
};

describe('Builder preview state', () => {
  it('marks the last preview stale as soon as the durable workspace advances', () => {
    const ready = {
      ...idleBuilderPreviewState(4),
      status: 'ready' as const,
      workspaceRevision: 4,
      active: successful,
      lastSuccessful: successful,
    };

    expect(previewStateForWorkspace(ready, 5, '2026-07-30T10:01:00.000Z')).toMatchObject({
      status: 'ready',
      currentWorkspaceRevision: 5,
      stale: true,
      active: successful,
    });
  });

  it('preserves the last successful preview when a replacement build fails', () => {
    const replacement = {
      ...idleBuilderPreviewState(5),
      status: 'building' as const,
      pendingId: 'preview-b',
      workspaceRevision: 5,
      lastSuccessful: successful,
    };

    expect(failedBuilderPreviewState(replacement, 5, 'Build failed', '2026-07-30T10:02:00.000Z')).toMatchObject({
      status: 'failed',
      pendingId: null,
      active: null,
      lastSuccessful: successful,
      stale: true,
      error: 'Build failed',
    });
  });

  it('never marks a dev preview stale, because it receives the change instead of missing it', () => {
    const live: BuilderDevPreview = {
      mode: 'dev',
      id: 'preview-dev',
      url: '/api/previews/id/token/',
      startedFromWorkspaceRevision: 4,
      readyAt: '2026-07-30T10:00:00.000Z',
      expiresAt: '2026-07-30T10:15:00.000Z',
    };
    const ready = {
      ...idleBuilderPreviewState(4),
      status: 'ready' as const,
      mode: 'dev' as const,
      workspaceRevision: 4,
      active: live,
      lastSuccessful: live,
    };

    expect(isPreviewStale(live, 99)).toBe(false);
    expect(isPreviewStale(successful, 4)).toBe(false);
    expect(isPreviewStale(successful, 5)).toBe(true);
    expect(previewStateForWorkspace(ready, 40, '2026-07-30T10:01:00.000Z')).toMatchObject({
      status: 'ready',
      currentWorkspaceRevision: 40,
      stale: false,
      active: live,
    });
  });

  it('exposes where a preview came from without letting a dev preview claim a bound revision', () => {
    const live: BuilderDevPreview = {
      mode: 'dev',
      id: 'preview-dev',
      url: '/api/previews/id/token/',
      startedFromWorkspaceRevision: 7,
      readyAt: '2026-07-30T10:00:00.000Z',
      expiresAt: '2026-07-30T10:15:00.000Z',
    };

    expect(previewOriginWorkspaceRevision(live)).toBe(7);
    expect(previewOriginWorkspaceRevision(successful)).toBe(4);
    // A dev preview carries no source digest at all: nothing can read a validated revision off it.
    expect('snapshotRevision' in live).toBe(false);
  });
});
