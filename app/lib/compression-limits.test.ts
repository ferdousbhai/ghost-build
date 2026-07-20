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

  it('accepts a structurally complete bounded literal block', () => {
    const payload = literalBlock(new TextEncoder().encode('hello'));

    expect(assertLz4Payload(payload, PROJECT_SNAPSHOT_LZ4_LIMITS)).toBe(5);
  });

  it('accepts a match block emitted by the configured lz4-wasm compressor', () => {
    const compressedZeros = new Uint8Array([100, 0, 0, 0, 31, 0, 1, 0, 74, 96, 0, 0, 0, 0, 0, 0]);

    expect(assertLz4Payload(compressedZeros, PROJECT_SNAPSHOT_LZ4_LIMITS)).toBe(100);
    expect(assertLz4Payload(new Uint8Array([0, 0, 0, 0, 0]), PROJECT_SNAPSHOT_LZ4_LIMITS)).toBe(0);
  });

  it('rejects malformed payloads before decompression', () => {
    expect(() => assertLz4Payload(new Uint8Array(3), MESSAGE_HISTORY_LZ4_LIMITS)).toThrow('not a valid LZ4 payload');
  });

  it.each([
    ['truncated literal', new Uint8Array([2, 0, 0, 0, 0x20, 1])],
    ['zero match offset', new Uint8Array([4, 0, 0, 0, 0, 0, 0, 0])],
    ['offset before produced output', new Uint8Array([4, 0, 0, 0, 0, 1, 0, 0])],
    ['declared output mismatch', new Uint8Array([2, 0, 0, 0, 0x10, 1])],
    ['truncated length extension', new Uint8Array([15, 0, 0, 0, 0xf0])],
  ])('rejects %s framing', (_label, payload) => {
    expect(() => assertLz4Payload(payload, MESSAGE_HISTORY_LZ4_LIMITS)).toThrow(Lz4PayloadError);
  });
});

function lz4Header(decompressedBytes: number): Uint8Array {
  const payload = new Uint8Array(5);
  new DataView(payload.buffer).setUint32(0, decompressedBytes, true);
  return payload;
}

function literalBlock(literals: Uint8Array): Uint8Array {
  const payload = new Uint8Array(5 + literals.byteLength);
  new DataView(payload.buffer).setUint32(0, literals.byteLength, true);
  payload[4] = literals.byteLength << 4;
  payload.set(literals, 5);
  return payload;
}
