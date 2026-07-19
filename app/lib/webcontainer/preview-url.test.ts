import { describe, expect, test } from 'vitest';
import { isWebContainerPreviewId, webContainerPreviewIdFromUrl, webContainerPreviewUrl } from './preview-url';

describe('WebContainer preview URLs', () => {
  const previewId = 'k03e2io1v3fx9wvj0vr8qd5q58o56n-fkdo-p263xdja--50415--d4eba4a9';

  test('round-trips a valid WebContainer preview URL', () => {
    const url = webContainerPreviewUrl(previewId);

    expect(url).toBe(`https://${previewId}.local-credentialless.webcontainer-api.io`);
    expect(webContainerPreviewIdFromUrl(url)).toBe(previewId);
  });

  test('rejects IDs that could change the constructed URL authority', () => {
    expect(isWebContainerPreviewId('preview.example.com')).toBe(false);
    expect(isWebContainerPreviewId('preview/path')).toBe(false);
    expect(() => webContainerPreviewUrl('preview?redirect=example.com')).toThrow('Invalid WebContainer preview ID');
  });

  test('rejects lookalike and insecure proxy origins', () => {
    expect(
      webContainerPreviewIdFromUrl(`https://${previewId}.local-credentialless.webcontainer-api.io.evil.test`),
    ).toBe(null);
    expect(webContainerPreviewIdFromUrl(`http://${previewId}.local-credentialless.webcontainer-api.io`)).toBe(null);
  });
});
