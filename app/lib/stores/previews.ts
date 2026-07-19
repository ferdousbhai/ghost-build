import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { MAX_THUMBNAIL_BYTES } from '~/lib/thumbnail-policy';
import { atom } from 'nanostores';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { withResolvers } from '~/utils/promises';

export interface PreviewInfo {
  port: number;
  ready: boolean;
  baseUrl: string;
  iframe: HTMLIFrameElement | null;
}

const PROXY_PORT_RANGE_START = 0xc4ef;
const PROXY_START_TIMEOUT_MS = 10_000;
const SCREENSHOT_RESPONSE_TIMEOUT_MS = 10_000;
const MAX_SCREENSHOT_BASE64_CHARACTERS = Math.ceil(MAX_THUMBNAIL_BYTES / 3) * 4;
const MAX_PREVIEW_ERROR_MESSAGE_CHARACTERS = 2_000;
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE_BASE64 = 'iVBORw0KGgo';
const PREVIEW_CHANNEL = 'preview-updates';
const logger = createScopedLogger('PreviewsStore');

// This is a separate codebase.
// eslint-disable-next-line no-restricted-imports
import PROXY_SERVER_SOURCE from '../../../proxy/proxy.bundled.cjs?raw';

type ProxyState = { start: (arg: { proxyUrl: string }) => void; stop: () => void };

export class PreviewsStore {
  #webcontainer: Promise<WebContainer>;
  #nextProxyPort = PROXY_PORT_RANGE_START;

  previews = atom<PreviewInfo[]>([]);

  #proxies = new Map<number, ProxyState>();
  #externalPreviewChannels = new Map<number, BroadcastChannel>();

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;
    void this.#init().catch((error) => logger.error('Failed to initialize preview listeners', error));
  }

  async #init() {
    const webcontainer = await this.#webcontainer;

    webcontainer.on('server-ready', (port, url) => {
      logger.debug('Server ready on port', port, url);

      if (this.#proxies.has(port)) {
        this.#proxies.get(port)?.start({ proxyUrl: url });
        return;
      }

      this.#upsertPreview(port, true, url);
    });

    webcontainer.on('port', (port, type, url) => {
      if (this.#proxies.has(port)) {
        if (type === 'open') {
          this.#proxies.get(port)?.start({ proxyUrl: url });
        }
        return;
      }

      if (type === 'close' && this.previews.get().some((preview) => preview.port === port)) {
        this.previews.set(this.previews.get().filter((preview) => preview.port !== port));
      }
    });
  }

  #upsertPreview(port: number, ready: boolean, url: string) {
    const previews = this.previews.get();
    const previewIndex = previews.findIndex((preview) => preview.port === port);
    if (previewIndex === -1) {
      this.previews.set([...previews, { port, ready, baseUrl: url, iframe: null }]);
      return;
    }
    this.previews.set(
      previews.map((preview, index) => (index === previewIndex ? { ...preview, ready, baseUrl: url } : preview)),
    );
  }

  setPreviewIframe(previewPort: number, iframe: HTMLIFrameElement | null): void {
    this.previews.set(
      this.previews.get().map((preview) => (preview.port === previewPort ? { ...preview, iframe } : preview)),
    );
  }

  /**
   * Starts a proxy server for the given source port.
   *
   * Proxy servers are used so that each time a preview is shown on screen,
   * each preview has a different origin. This helps when testing apps with
   * auth with multiple users.
   */
  async startProxy(sourcePort: number): Promise<{ proxyPort: number; proxyUrl: string }> {
    const targetPort = this.#nextProxyPort++;
    const { promise: onStart, resolve: start } = withResolvers<{ proxyUrl: string }>();

    const proxyLogger = createScopedLogger(`Proxy ${targetPort} → ${sourcePort}`);

    const proxyState: ProxyState = {
      start,
      stop() {
        // This should never happen since the external users don’t get access to
        // the ProxyState object before `startProxy` returns (unless they guess
        // the port number)
        throw new Error('Proxy not started');
      },
    };
    this.#proxies.set(targetPort, proxyState);

    let proxyProcess: WebContainerProcess | undefined;
    try {
      // Start the HTTP + HMR WebSocket proxy
      const webcontainer = await this.#webcontainer;

      const proxyScriptLocation = '/tmp/previewProxy.cjs';
      // webcontainer.writeFile seems incapable of writing to /tmp/foo
      // so use sh instead. It's important that this string has no
      // single quote characters ' in it so this naive escaping works.
      const writeProxyProcess = await webcontainer.spawn('sh', [
        '-c',
        `echo '${PROXY_SERVER_SOURCE}' > ${proxyScriptLocation}`,
      ]);
      const writeExitCode = await writeProxyProcess.exit;
      if (writeExitCode !== 0) {
        throw new Error(`Failed to write preview proxy script (exit code ${writeExitCode})`);
      }
      proxyProcess = await webcontainer.spawn('node', [
        proxyScriptLocation,
        sourcePort.toString(),
        targetPort.toString(),
      ]);
      const startedProxyProcess = proxyProcess;

      proxyState.stop = () => {
        proxyLogger.info('Stopping proxy');
        startedProxyProcess.kill();
      };

      void startedProxyProcess.output
        .pipeTo(
          new WritableStream({
            write(data) {
              proxyLogger.info(data);
            },
          }),
        )
        .catch((error) => proxyLogger.debug('Proxy output stream closed', error));

      const proxyExit = startedProxyProcess.exit.then((exitCode) => {
        if (this.#proxies.get(targetPort) === proxyState) {
          this.#proxies.delete(targetPort);
        }
        this.#externalPreviewChannels.get(targetPort)?.close();
        this.#externalPreviewChannels.delete(targetPort);
        throw new Error(`Preview proxy exited before becoming ready (exit code ${exitCode})`);
      });
      const { proxyUrl } = await withTimeout(
        Promise.race([onStart, proxyExit]),
        PROXY_START_TIMEOUT_MS,
        'Preview proxy start timed out',
      );
      return { proxyPort: targetPort, proxyUrl };
    } catch (error) {
      proxyProcess?.kill();
      this.#proxies.delete(targetPort);
      throw error;
    }
  }

  /**
   * Called when a proxy server is no longer used and it can be released.
   */
  stopProxy(proxyPort: number) {
    this.#externalPreviewChannels.get(proxyPort)?.close();
    this.#externalPreviewChannels.delete(proxyPort);
    const proxy = this.#proxies.get(proxyPort);
    if (!proxy) {
      return;
    }

    proxy.stop();
    this.#proxies.delete(proxyPort);
  }

  trackExternalPreview(proxyPort: number, previewId: string) {
    if (!this.#proxies.has(proxyPort)) {
      return;
    }
    this.#externalPreviewChannels.get(proxyPort)?.close();
    const channel = new BroadcastChannel(PREVIEW_CHANNEL);
    channel.addEventListener('message', (event) => {
      if (event.data?.type === 'preview-closed' && event.data.previewId === previewId) {
        this.stopProxy(proxyPort);
      }
    });
    this.#externalPreviewChannels.set(proxyPort, channel);
  }

  async requestAnyScreenshot(timeout = 30000): Promise<string> {
    const deadline = Date.now() + Math.max(0, timeout);
    while (true) {
      const previewIndex = this.previews.get().findIndex((preview) => preview.iframe?.contentWindow);
      if (previewIndex !== -1) {
        return this.requestScreenshot(previewIndex, Math.max(1, deadline - Date.now()));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('No preview became available before the screenshot timeout');
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
  }

  async requestScreenshot(previewIndex: number, timeoutMs = SCREENSHOT_RESPONSE_TIMEOUT_MS): Promise<string> {
    const iframe = this.previews.get()[previewIndex]?.iframe;
    if (!iframe) {
      throw new Error('No preview yet');
    }
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) {
      throw new Error('No preview yet');
    }

    const targetOrigin = new URL(iframe.src).origin;
    const requestId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener('message', handleMessage);
      };
      const handleMessage = (event: MessageEvent) => {
        if (
          event.origin !== targetOrigin ||
          event.source !== contentWindow ||
          !hasPreviewRequestId(event.data, requestId)
        ) {
          return;
        }
        cleanup();
        if (!isPreviewResponse(event.data, requestId)) {
          reject(new Error('Invalid screenshot response'));
          return;
        }
        if (event.data.type === 'ghostbuildPreviewError') {
          reject(new Error(event.data.message));
          return;
        }
        resolve(event.data.data);
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Screenshot timeout'));
      }, timeoutMs);
      window.addEventListener('message', handleMessage);
      try {
        contentWindow.postMessage(
          {
            type: 'ghostbuildPreviewRequest',
            request: 'screenshot',
            requestId,
          },
          targetOrigin,
        );
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}

type PreviewResponse =
  | { type: 'screenshot'; requestId: string; data: string }
  | { type: 'ghostbuildPreviewError'; requestId: string; message: string };

function hasPreviewRequestId(
  value: unknown,
  requestId: string,
): value is { requestId: string } & Record<string, unknown> {
  return typeof value === 'object' && value !== null && 'requestId' in value && value.requestId === requestId;
}

function isPreviewResponse(value: unknown, requestId: string): value is PreviewResponse {
  if (typeof value !== 'object' || value === null || !('type' in value) || !('requestId' in value)) {
    return false;
  }
  if (value.requestId !== requestId) {
    return false;
  }
  if (value.type === 'screenshot') {
    return 'data' in value && isBoundedPngDataUrl(value.data);
  }
  return (
    value.type === 'ghostbuildPreviewError' &&
    'message' in value &&
    typeof value.message === 'string' &&
    value.message.length <= MAX_PREVIEW_ERROR_MESSAGE_CHARACTERS
  );
}

function isBoundedPngDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(PNG_DATA_URL_PREFIX)) {
    return false;
  }
  const encoded = value.slice(PNG_DATA_URL_PREFIX.length);
  if (
    encoded.length === 0 ||
    encoded.length > MAX_SCREENSHOT_BASE64_CHARACTERS ||
    encoded.length % 4 !== 0 ||
    !encoded.startsWith(PNG_SIGNATURE_BASE64) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    return false;
  }
  const paddingBytes = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return (encoded.length / 4) * 3 - paddingBytes <= MAX_THUMBNAIL_BYTES;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
