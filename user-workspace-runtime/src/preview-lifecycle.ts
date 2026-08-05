export const PREVIEW_PORT_MIN = 4173;
export const PREVIEW_PORT_COUNT = 100;
export const PREVIEW_TTL_MS = 15 * 60_000;
export const PREVIEW_SNAPSHOT_ROOT = '/tmp/ghostbuild-previews';

type PreviewCheckpoint = {
  workspaceRevision: number;
  revision: string;
};

export function assertPreviewSourceCheckpoint(
  actual: PreviewCheckpoint,
  expected: PreviewCheckpoint,
  requireWorkspaceRevision: boolean,
): PreviewCheckpoint {
  if (
    actual.revision !== expected.revision ||
    (requireWorkspaceRevision && actual.workspaceRevision !== expected.workspaceRevision)
  ) {
    throw new Error('The project changed before its preview became ready. Build a preview of the new revision.');
  }
  return actual;
}

export function assertPreviewPublicationAllowed(cancelled: boolean): void {
  if (cancelled) {
    throw new Error('The preview build was cancelled before publication.');
  }
}

export function previewPort(previewId: string, unavailablePort?: number): number {
  let hash = 2_166_136_261;
  for (const character of previewId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  let port = PREVIEW_PORT_MIN + ((hash >>> 0) % PREVIEW_PORT_COUNT);
  if (port === unavailablePort) {
    port = PREVIEW_PORT_MIN + ((port - PREVIEW_PORT_MIN + 1) % PREVIEW_PORT_COUNT);
  }
  return port;
}
