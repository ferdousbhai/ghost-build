const MEBIBYTE = 1024 * 1024;
const LZ4_SIZE_PREFIX_BYTES = 4;

export type Lz4PayloadLimits = {
  compressedBytes: number;
  decompressedBytes: number;
  label: string;
};

export const MESSAGE_HISTORY_LZ4_LIMITS: Lz4PayloadLimits = {
  compressedBytes: 8 * MEBIBYTE,
  decompressedBytes: 32 * MEBIBYTE,
  label: 'Message history',
};

export const PROJECT_SNAPSHOT_LZ4_LIMITS: Lz4PayloadLimits = {
  compressedBytes: 10 * MEBIBYTE,
  decompressedBytes: 64 * MEBIBYTE,
  label: 'Project snapshot',
};

export class Lz4PayloadError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid' | 'too-large',
  ) {
    super(message);
    this.name = 'Lz4PayloadError';
  }
}

function assertLz4PayloadSize(compressedBytes: number, sizePrefix: Uint8Array, limits: Lz4PayloadLimits): number {
  if (compressedBytes < LZ4_SIZE_PREFIX_BYTES || sizePrefix.byteLength < LZ4_SIZE_PREFIX_BYTES) {
    throw new Lz4PayloadError(`${limits.label} is not a valid LZ4 payload.`, 'invalid');
  }
  if (compressedBytes > limits.compressedBytes) {
    throw new Lz4PayloadError(
      `${limits.label} exceeds the ${formatMebibytes(limits.compressedBytes)} compressed limit.`,
      'too-large',
    );
  }
  const decompressedBytes = new DataView(sizePrefix.buffer, sizePrefix.byteOffset, sizePrefix.byteLength).getUint32(
    0,
    true,
  );
  if (decompressedBytes > limits.decompressedBytes) {
    throw new Lz4PayloadError(
      `${limits.label} exceeds the ${formatMebibytes(limits.decompressedBytes)} expanded limit.`,
      'too-large',
    );
  }
  return decompressedBytes;
}

export function assertLz4Payload(input: Uint8Array, limits: Lz4PayloadLimits): number {
  const declaredBytes = assertLz4PayloadSize(input.byteLength, input.subarray(0, LZ4_SIZE_PREFIX_BYTES), limits);
  if (input.byteLength === LZ4_SIZE_PREFIX_BYTES) {
    throw invalidLz4Payload(limits);
  }

  let inputOffset = LZ4_SIZE_PREFIX_BYTES;
  let outputOffset = 0;
  while (inputOffset < input.byteLength) {
    const token = input[inputOffset++];
    if (token === undefined) {
      throw invalidLz4Payload(limits);
    }
    const literalLength = readLz4Length(input, token >>> 4, () => inputOffset++);
    if (literalLength > input.byteLength - inputOffset || outputOffset + literalLength > declaredBytes) {
      throw invalidLz4Payload(limits);
    }
    inputOffset += literalLength;
    outputOffset += literalLength;
    if (inputOffset === input.byteLength) {
      break;
    }
    if (input.byteLength - inputOffset < 2) {
      throw invalidLz4Payload(limits);
    }
    const matchOffset = input[inputOffset]! | (input[inputOffset + 1]! << 8);
    inputOffset += 2;
    if (matchOffset === 0 || matchOffset > outputOffset) {
      throw invalidLz4Payload(limits);
    }
    const matchLength = readLz4Length(input, token & 0x0f, () => inputOffset++) + 4;
    if (outputOffset + matchLength > declaredBytes || inputOffset === input.byteLength) {
      throw invalidLz4Payload(limits);
    }
    outputOffset += matchLength;
  }
  if (outputOffset !== declaredBytes) {
    throw invalidLz4Payload(limits);
  }
  return declaredBytes;
}

function readLz4Length(input: Uint8Array, tokenLength: number, advance: () => number): number {
  let length = tokenLength;
  if (tokenLength !== 15) {
    return length;
  }
  while (true) {
    const offset = advance();
    const extension = input[offset];
    if (extension === undefined) {
      throw new Lz4PayloadError('LZ4 payload has a truncated length extension.', 'invalid');
    }
    length += extension;
    if (extension !== 255) {
      return length;
    }
  }
}

function invalidLz4Payload(limits: Lz4PayloadLimits): Lz4PayloadError {
  return new Lz4PayloadError(`${limits.label} is not a valid LZ4 payload.`, 'invalid');
}

function formatMebibytes(bytes: number): string {
  return `${bytes / MEBIBYTE} MiB`;
}
