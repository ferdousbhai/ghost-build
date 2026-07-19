const WEBCONTAINER_PREVIEW_HOST_SUFFIX = '.local-credentialless.webcontainer-api.io';
const PREVIEW_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isWebContainerPreviewId(value: string): boolean {
  return PREVIEW_ID_PATTERN.test(value);
}

export function webContainerPreviewUrl(previewId: string): string {
  if (!isWebContainerPreviewId(previewId)) {
    throw new Error('Invalid WebContainer preview ID');
  }
  return `https://${previewId}${WEBCONTAINER_PREVIEW_HOST_SUFFIX}`;
}

export function webContainerPreviewIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      !url.hostname.endsWith(WEBCONTAINER_PREVIEW_HOST_SUFFIX)
    ) {
      return null;
    }
    const previewId = url.hostname.slice(0, -WEBCONTAINER_PREVIEW_HOST_SUFFIX.length);
    return isWebContainerPreviewId(previewId) ? previewId : null;
  } catch {
    return null;
  }
}
