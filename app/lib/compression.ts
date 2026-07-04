import * as lz4 from 'lz4-wasm';

export function compressWithLz4(uint8Array: Uint8Array): Uint8Array {
  // Dynamic import only executed on the client
  if (typeof window === 'undefined') {
    throw new Error('compressWithLz4 can only be used in browser environments');
  }
  return lz4.compress(uint8Array);
}

export function decompressWithLz4(uint8Array: Uint8Array): Uint8Array {
  // Dynamic import only executed on the client
  if (typeof window === 'undefined') {
    throw new Error('decompressWithLz4 can only be used in browser environments');
  }
  return lz4.decompress(uint8Array);
}
