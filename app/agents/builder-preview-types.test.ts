import { describe, expect, it } from 'vitest';
import {
  failedBuilderPreviewState,
  idleBuilderPreviewState,
  previewStateForWorkspace,
  type BuilderPreviewSuccess,
} from './builder-preview-types';

const successful: BuilderPreviewSuccess = {
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
});
