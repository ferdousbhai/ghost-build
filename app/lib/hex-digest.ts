/**
 * Lowercase hex encoding of a byte buffer, optionally truncated to the first
 * `byteLength` bytes. Truncating here rather than slicing the hex string keeps
 * callers from having to reason about the 2-chars-per-byte factor.
 */
export function bytesToHex(input: ArrayBuffer | Uint8Array<ArrayBuffer>, byteLength?: number): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = byteLength === undefined ? bytes : bytes.subarray(0, byteLength);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of a UTF-8 string or byte buffer, as lowercase hex. */
export async function sha256Hex(
  value: string | ArrayBuffer | Uint8Array<ArrayBuffer>,
  byteLength?: number,
): Promise<string> {
  const input = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return bytesToHex(await crypto.subtle.digest('SHA-256', input), byteLength);
}
