// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThumbnailChooser } from './useThumbnailChooser';

const uploadThumbnailMock = vi.hoisted(() => vi.fn());
const invalidateQueriesMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock('./thumbnail-upload.client', () => ({ uploadThumbnail: uploadThumbnailMock }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}));
vi.mock('~/lib/cloudflare/data-hooks', () => ({ useQuery: () => null }));
vi.mock('~/lib/stores/chatId', () => ({ useChatId: () => 'chat' }));
vi.mock('~/lib/stores/sessionId', () => ({ useSessionId: () => 'session' }));
vi.mock('sonner', () => ({ toast: { error: toastErrorMock, success: vi.fn() } }));

type Controller = ReturnType<typeof useThumbnailChooser>;
const PREVIEW = 'data:image/png;base64,aW1hZ2U=';

let latestController: Controller | undefined;
let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  latestController = undefined;
  uploadThumbnailMock.mockReset();
  invalidateQueriesMock.mockClear();
  toastErrorMock.mockReset();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

describe('useThumbnailChooser upload cancellation', () => {
  it('aborts an active upload when Close is requested and suppresses the abort error', async () => {
    const onOpenChange = vi.fn();
    const observed = installPendingUpload();
    await renderChooser(onOpenChange);
    await startUpload();

    await act(async () => {
      latestController?.cancel();
      await Promise.resolve();
    });

    expect(observed.signal?.aborted).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('aborts an active upload when a replacement capture starts', async () => {
    const observed = installPendingUpload();
    await renderChooser(vi.fn());
    await startUpload();

    await act(async () => {
      await latestController?.captureNewImage();
    });

    expect(observed.signal?.aborted).toBe(true);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('aborts an active upload on unmount', async () => {
    const observed = installPendingUpload();
    await renderChooser(vi.fn());
    await startUpload();

    await act(async () => root?.unmount());
    root = undefined;

    expect(observed.signal?.aborted).toBe(true);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

function installPendingUpload(): { signal?: AbortSignal } {
  const observed: { signal?: AbortSignal } = {};
  uploadThumbnailMock.mockImplementation(
    async (_image: string, _sessionId: string, _chatId: string, signal: AbortSignal) => {
      observed.signal = signal;
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  );
  return observed;
}

async function renderChooser(onOpenChange: (open: boolean) => void): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  function Harness() {
    const [isOpen, setIsOpen] = useState(true);
    latestController = useThumbnailChooser({
      isOpen,
      onOpenChange(open) {
        onOpenChange(open);
        setIsOpen(open);
      },
      onRequestCapture: async () => PREVIEW,
    });
    return null;
  }

  await act(async () => {
    root?.render(<Harness />);
    await Promise.resolve();
  });
  expect(latestController?.localPreview).toBe(PREVIEW);
}

async function startUpload(): Promise<void> {
  await act(async () => {
    void latestController?.uploadImage();
    await Promise.resolve();
  });
  expect(latestController?.isUploading).toBe(true);
}
