import { getEncoding } from 'istextorbinary';
import { Buffer } from 'node:buffer';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';

const logger = createScopedLogger('FileContent');
const utf8TextDecoder = new TextDecoder('utf8', { fatal: true });

export function isBinaryFile(buffer: Uint8Array | undefined): boolean {
  if (buffer === undefined) {
    return false;
  }
  const nodeBuffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return getEncoding(nodeBuffer, { chunkLength: 100 }) === 'binary';
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
