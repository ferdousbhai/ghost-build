import { MAX_THUMBNAIL_BYTES } from '~/lib/thumbnail-policy';

export { MAX_THUMBNAIL_BYTES as MAX_THUMBNAIL_FILE_BYTES } from '~/lib/thumbnail-policy';

export function thumbnailFileValidationError(file: Pick<File, 'size' | 'type'>): string | null {
  if (!file.type.startsWith('image/')) {
    return 'Choose an image file.';
  }
  if (file.size === 0) {
    return 'The image file is empty.';
  }
  if (file.size > MAX_THUMBNAIL_BYTES) {
    return 'Choose an image no larger than 5 MB.';
  }
  return null;
}
