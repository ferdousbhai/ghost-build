export const PREVIEW_PORT_MIN = 4173;
export const PREVIEW_PORT_COUNT = 100;
export const PREVIEW_TTL_MS = 60 * 60_000;
export const PREVIEW_SNAPSHOT_ROOT = '/tmp/ghostbuild-previews';
const PREVIEW_PUBLICATION_ATTEMPTS = 10;
const PREVIEW_PUBLICATION_RETRY_DELAY_MS = 1_000;
const PREVIEW_PUBLICATION_REQUEST_TIMEOUT_MS = 3_000;

type PreviewTunnel = { url: string };

type PreviewTunnels<Tunnel extends PreviewTunnel> = {
  get(port: number): Promise<Tunnel>;
  destroy(port: number): Promise<void>;
};

type PreviewPublicationOptions = {
  attempts?: number;
  fetcher?: typeof fetch;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
};

type PreviewExpirationAction = { action: 'expire' } | { action: 'reschedule'; at: number };

export function previewExpirationAction(expiresAt: number | null, now = Date.now()): PreviewExpirationAction {
  return expiresAt !== null && expiresAt > now
    ? { action: 'reschedule', at: Math.ceil(expiresAt / 1_000) * 1_000 }
    : { action: 'expire' };
}

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

export async function createReachablePreviewTunnel<Tunnel extends PreviewTunnel>(
  tunnels: PreviewTunnels<Tunnel>,
  port: number,
  options: PreviewPublicationOptions = {},
): Promise<Tunnel> {
  let lastError: unknown;
  for (let tunnelAttempt = 0; tunnelAttempt < 2; tunnelAttempt += 1) {
    if (tunnelAttempt > 0) {
      await tunnels.destroy(port);
    }
    const tunnel = await tunnels.get(port);
    try {
      await waitForPreviewPublication(tunnel.url, options);
      return tunnel;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function waitForPreviewPublication(url: string, options: PreviewPublicationOptions = {}): Promise<void> {
  const attempts = options.attempts ?? PREVIEW_PUBLICATION_ATTEMPTS;
  const fetcher = options.fetcher ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? PREVIEW_PUBLICATION_REQUEST_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? PREVIEW_PUBLICATION_RETRY_DELAY_MS;
  const wait = options.wait ?? ((delayMs: number) => scheduler.wait(delayMs));
  let lastFailure = 'not reachable';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      void response.body?.cancel().catch(() => undefined);
      if (response.status >= 200 && response.status < 400) {
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) {
      await wait(retryDelayMs);
    }
  }

  throw new Error(`Preview tunnel did not become reachable: ${lastFailure}`);
}
