import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadThumbnail } from './thumbnail-upload.client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadThumbnail', () => {
  it('propagates one abort signal through image decoding and upload', async () => {
    const controller = new AbortController();
    const blob = new Blob(['image'], { type: 'image/png' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(blob))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await uploadThumbnail('data:image/png;base64,aW1hZ2U=', 'session', 'chat', controller.signal);

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'data:image/png;base64,aW1hZ2U=', { signal: controller.signal });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/thumbnails?sessionId=session&chatId=chat',
      expect.objectContaining({ method: 'POST', body: expect.any(Blob), signal: controller.signal }),
    );
  });

  it('does not start the upload when cancellation wins during image decoding', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue({
      blob: async () => {
        controller.abort();
        return new Blob(['image'], { type: 'image/png' });
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadThumbnail('data:image/png;base64,aW1hZ2U=', 'session', 'chat', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
