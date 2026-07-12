// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContainer } from '@webcontainer/api';
import { PreviewsStore } from './previews';

const mountedIframes: HTMLIFrameElement[] = [];

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
          data: { type: 'screenshot', requestId, data: 'data:image/png;base64,test' },
          origin: new URL(iframe.src).origin,
          source: contentWindow,
        }),
      );
    });

    await expect(store.requestScreenshot(0)).resolves.toBe('data:image/png;base64,test');
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
