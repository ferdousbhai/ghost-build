import { describe, expect, it } from 'vitest';
import {
  assertLz4Payload,
  Lz4PayloadError,
  MESSAGE_HISTORY_LZ4_LIMITS,
  PROJECT_SNAPSHOT_LZ4_LIMITS,
} from './compression-limits';

describe('LZ4 payload limits', () => {
  it('rejects a small compressed payload that declares excessive expansion', () => {
    const payload = lz4Header(MESSAGE_HISTORY_LZ4_LIMITS.decompressedBytes + 1);

    expect(() => assertLz4Payload(payload, MESSAGE_HISTORY_LZ4_LIMITS)).toThrow(Lz4PayloadError);
  });

  it('accepts a bounded payload size prefix', () => {
    const payload = lz4Header(PROJECT_SNAPSHOT_LZ4_LIMITS.decompressedBytes);

    expect(assertLz4Payload(payload, PROJECT_SNAPSHOT_LZ4_LIMITS)).toBe(PROJECT_SNAPSHOT_LZ4_LIMITS.decompressedBytes);
  });

  it('rejects malformed payloads before decompression', () => {
    expect(() => assertLz4Payload(new Uint8Array(3), MESSAGE_HISTORY_LZ4_LIMITS)).toThrow('not a valid LZ4 payload');
  });
});

function lz4Header(decompressedBytes: number): Uint8Array {
  const payload = new Uint8Array(5);
  new DataView(payload.buffer).setUint32(0, decompressedBytes, true);
  return payload;
}
