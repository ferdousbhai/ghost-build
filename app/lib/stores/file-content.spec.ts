import { describe, expect, it } from 'vitest';
import { decodeFileContent, isBinaryFile } from './file-content';

describe('file content helpers', () => {
  it('decodes UTF-8 text', () => {
    const content = new TextEncoder().encode('hello 👻');
    expect(isBinaryFile(content)).toBe(false);
    expect(decodeFileContent(content)).toBe('hello 👻');
  });

  it('treats missing content as an empty text file', () => {
    expect(isBinaryFile(undefined)).toBe(false);
    expect(decodeFileContent(undefined)).toBe('');
  });
});
