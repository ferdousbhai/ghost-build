import { previewQuickTunnelUrl } from '../../app/lib/common/preview-url';

type PreviewTunnel = {
  url: string;
};

type PreviewTunnelGetter = {
  get(port: number): Promise<PreviewTunnel>;
};

type PreviewTunnels = PreviewTunnelGetter & {
  destroy(port: number): Promise<unknown>;
};

type PreviewTunnelReadinessOptions = {
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
  wait?: (delayMs: number) => Promise<void>;
};

const PREVIEW_TUNNEL_READY_TIMEOUT_MS = 30_000;

export function openPreviewQuickTunnel(tunnels: PreviewTunnelGetter, port: number): Promise<PreviewTunnel> {
  return tunnels.get(port);
}

export async function openReadyPreviewQuickTunnel(
  tunnels: PreviewTunnels,
  port: number,
  options: PreviewTunnelReadinessOptions = {},
): Promise<PreviewTunnel> {
  const first = await openPreviewQuickTunnel(tunnels, port);
  try {
    await waitForPreviewQuickTunnel(first.url, options);
    return first;
  } catch {
    await tunnels.destroy(port);
  }
  const replacement = await openPreviewQuickTunnel(tunnels, port);
  await waitForPreviewQuickTunnel(replacement.url, options);
  return replacement;
}

export async function waitForPreviewQuickTunnel(
  value: string,
  options: PreviewTunnelReadinessOptions = {},
): Promise<void> {
  const url = requirePreviewQuickTunnelUrl(value);
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((delayMs: number) => scheduler.wait(delayMs));
  const deadline = now() + (options.timeoutMs ?? PREVIEW_TUNNEL_READY_TIMEOUT_MS);
  let lastFailure = 'not ready';
  while (now() < deadline) {
    try {
      const response = await fetcher(url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - now()))),
      });
      if (response.status >= 200 && response.status < 400) {
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await wait(Math.min(500, Math.max(1, deadline - now())));
  }
  throw new Error(`Preview tunnel did not become ready: ${lastFailure}`);
}

function requirePreviewQuickTunnelUrl(value: string): string {
  const url = previewQuickTunnelUrl(value);
  if (!url) {
    throw new Error('Preview tunnel returned an invalid URL.');
  }
  return url;
}
