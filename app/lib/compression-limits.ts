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

export function assertLz4PayloadSize(
  compressedBytes: number,
  sizePrefix: Uint8Array,
  limits: Lz4PayloadLimits,
): number {
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
  return assertLz4PayloadSize(input.byteLength, input.subarray(0, LZ4_SIZE_PREFIX_BYTES), limits);
}

function formatMebibytes(bytes: number): string {
  return `${bytes / MEBIBYTE} MiB`;
}
