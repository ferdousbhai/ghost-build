// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContainer } from '@webcontainer/api';
import { PreviewsStore } from './previews';

const mountedIframes: HTMLIFrameElement[] = [];
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

afterEach(() => {
  for (const iframe of mountedIframes) {
    iframe.remove();
  }
  mountedIframes.length = 0;
  vi.restoreAllMocks();
});

describe('PreviewsStore screenshots', () => {
  it('rejects an out-of-range preview index', async () => {
    const store = createStore();

    await expect(store.requestScreenshot(-1)).rejects.toThrow('No preview yet');
  });

  it('registers a correlated response listener before posting the request', async () => {
    const store = createStore();
    const iframe = createIframe();
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) {
      throw new Error('Expected the test iframe to have a content window');
    }
    store.previews.set([{ port: 3000, ready: true, baseUrl: iframe.src, iframe }]);
    vi.spyOn(contentWindow, 'postMessage').mockImplementation((request) => {
      const requestId = (request as { requestId: string }).requestId;
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'screenshot', requestId, data: ONE_PIXEL_PNG },
          origin: new URL(iframe.src).origin,
          source: contentWindow,
        }),
      );
    });

    await expect(store.requestScreenshot(0)).resolves.toBe(ONE_PIXEL_PNG);
  });

  it('rejects a correlated screenshot response that is not a PNG data URL', async () => {
    const { store, contentWindow } = storeWithRespondingIframe('/api/auth/session');

    await expect(store.requestScreenshot(0, 100)).rejects.toThrow('Invalid screenshot response');
    expect(contentWindow.postMessage).toHaveBeenCalledOnce();
  });

  it('rejects non-PNG bytes mislabeled as a PNG data URL', async () => {
    const { store } = storeWithRespondingIframe('data:image/png;base64,dGVzdA==');

    await expect(store.requestScreenshot(0, 100)).rejects.toThrow('Invalid screenshot response');
  });

  it('rejects a correlated PNG data URL larger than the thumbnail limit', async () => {
    const oversizedPng = `data:image/png;base64,iVBORw0KGgo${'A'.repeat(7_000_001)}`;
    const { store, contentWindow } = storeWithRespondingIframe(oversizedPng);

    await expect(store.requestScreenshot(0, 100)).rejects.toThrow('Invalid screenshot response');
    expect(contentWindow.postMessage).toHaveBeenCalledOnce();
  });
});

describe('PreviewsStore server state', () => {
  it('preserves the iframe when server-ready refreshes an existing preview', async () => {
    const { store, emit } = await createEventStore();
    emit('server-ready', 3000, 'https://first.example.test');
    const iframe = createIframe();
    store.previews.set(store.previews.get().map((preview) => ({ ...preview, iframe })));

    emit('server-ready', 3000, 'https://second.example.test');

    expect(store.previews.get()).toEqual([{ port: 3000, ready: true, baseUrl: 'https://second.example.test', iframe }]);
  });

  it('removes a preview when its port closes', async () => {
    const { store, emit } = await createEventStore();
    emit('server-ready', 3000, 'https://preview.example.test');

    emit('port', 3000, 'close', 'https://preview.example.test');

    expect(store.previews.get()).toEqual([]);
  });

  it('attaches an iframe by stable port identity after the preview list changes', async () => {
    const { store, emit } = await createEventStore();
    emit('server-ready', 3000, 'https://first.example.test');
    emit('server-ready', 4000, 'https://second.example.test');
    const iframe = createIframe();

    emit('port', 3000, 'close', 'https://first.example.test');
    store.setPreviewIframe(4000, iframe);

    expect(store.previews.get()).toEqual([{ port: 4000, ready: true, baseUrl: 'https://second.example.test', iframe }]);
  });
});

function createStore(): PreviewsStore {
  return new PreviewsStore(
    new Promise<WebContainer>(() => {
      // Keep initialization pending; screenshot tests only exercise atom state.
    }),
  );
}

async function createEventStore(): Promise<{
  store: PreviewsStore;
  emit: (event: string, ...args: unknown[]) => void;
}> {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const webcontainer = {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
    },
  } as unknown as WebContainer;
  const store = new PreviewsStore(Promise.resolve(webcontainer));
  await Promise.resolve();
  return {
    store,
    emit(event, ...args) {
      const listener = listeners.get(event);
      if (!listener) {
        throw new Error(`No listener registered for ${event}`);
      }
      listener(...args);
    },
  };
}

function createIframe(): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.src = 'https://preview.example.test/';
  window.document.body.appendChild(iframe);
  mountedIframes.push(iframe);
  return iframe;
}

function storeWithRespondingIframe(data: string): {
  store: PreviewsStore;
  contentWindow: Window;
} {
  const store = createStore();
  const iframe = createIframe();
  const contentWindow = iframe.contentWindow;
  if (!contentWindow) {
    throw new Error('Expected the test iframe to have a content window');
  }
  store.previews.set([{ port: 3000, ready: true, baseUrl: iframe.src, iframe }]);
  vi.spyOn(contentWindow, 'postMessage').mockImplementation((request) => {
    const requestId = (request as { requestId: string }).requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'screenshot', requestId, data },
        origin: new URL(iframe.src).origin,
        source: contentWindow,
      }),
    );
  });
  return { store, contentWindow };
}
