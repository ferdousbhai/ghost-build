import { describe, expect, it } from 'vitest';
import { MAX_THUMBNAIL_BYTES } from '~/lib/thumbnail-policy';
import { thumbnailFileValidationError } from './thumbnail-file-policy';

describe('thumbnailFileValidationError', () => {
  it('accepts a non-empty image within the upload limit', () => {
    expect(thumbnailFileValidationError({ type: 'image/png', size: MAX_THUMBNAIL_BYTES })).toBeNull();
  });

  it('rejects non-images, empty images, and images above the upload limit', () => {
    expect(thumbnailFileValidationError({ type: 'text/plain', size: 10 })).toBe('Choose an image file.');
    expect(thumbnailFileValidationError({ type: 'image/png', size: 0 })).toBe('The image file is empty.');
    expect(thumbnailFileValidationError({ type: 'image/png', size: MAX_THUMBNAIL_BYTES + 1 })).toBe(
      'Choose an image no larger than 5 MB.',
    );
  });
});
