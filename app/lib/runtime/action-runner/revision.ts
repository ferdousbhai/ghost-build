export async function contentRevision(content: string): Promise<string> {
  return sha256(content);
}

export async function queryFingerprint(value: unknown): Promise<string> {
  return (await sha256(JSON.stringify(value))).slice(0, 16);
}

async function sha256(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
