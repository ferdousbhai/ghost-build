import { createScopedLogger } from 'ghostbuild-agent/utils/logger';

const logger = createScopedLogger('FileContent');
const utf8TextDecoder = new TextDecoder('utf8', { fatal: true });

export function isBinaryFile(buffer: Uint8Array | undefined): boolean {
  if (buffer === undefined) {
    return false;
  }
  if (buffer.some((byte) => byte <= 8)) {
    return true;
  }
  try {
    utf8TextDecoder.decode(buffer);
    return false;
  } catch {
    return true;
  }
}

export function decodeFileContent(buffer?: Uint8Array): string {
  if (!buffer?.byteLength) {
    return '';
  }
  try {
    return utf8TextDecoder.decode(buffer);
  } catch (error) {
    logger.debug('Failed to decode file content as UTF-8', error);
    return '';
  }
}
