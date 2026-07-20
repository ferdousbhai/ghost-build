import * as lz4 from 'lz4-wasm';
import { assertLz4Payload, type Lz4PayloadLimits } from './compression-limits';

export function compressWithLz4(uint8Array: Uint8Array): Uint8Array {
  // Dynamic import only executed on the client
  if (typeof window === 'undefined') {
    throw new Error('compressWithLz4 can only be used in browser environments');
  }
  return lz4.compress(uint8Array);
}

export function decompressWithLz4(uint8Array: Uint8Array, limits?: Lz4PayloadLimits): Uint8Array {
  // Dynamic import only executed on the client
  if (typeof window === 'undefined') {
    throw new Error('decompressWithLz4 can only be used in browser environments');
  }
  if (limits) {
    assertLz4Payload(uint8Array, limits);
  }
  const decompressed = lz4.decompress(uint8Array);
  if (limits && decompressed.byteLength > limits.decompressedBytes) {
    throw new Error(`${limits.label} exceeded its expanded size limit.`);
  }
  return decompressed;
}
