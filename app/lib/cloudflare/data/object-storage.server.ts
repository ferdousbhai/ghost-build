import { customerR2Api, GHOSTBUILD_CUSTOMER_BUCKET } from '~/lib/.server/cloudflare/customer-r2';

const CUSTOMER_OBJECT_PREFIX = 'customer-r2/v1';
type ObjectStorageEnv = Pick<Env, 'APP_STORAGE' | 'DB'>;

export function allocateObjectKey(prefix: string): string {
  return `${prefix}/${crypto.randomUUID()}`;
}

export function allocateCustomerObjectKey(ownerId: string, prefix: string): string {
  if (!ownerId || new TextEncoder().encode(ownerId).byteLength > 128 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(prefix)) {
    throw new Error('Customer object ownership is invalid.');
  }
  return `${CUSTOMER_OBJECT_PREFIX}/${base64UrlEncode(ownerId)}/${prefix}/${crypto.randomUUID()}`;
}

export function isCustomerObjectKey(key: string): boolean {
  return parseCustomerObjectKey(key) !== null;
}

export async function putObjectAtKey(env: ObjectStorageEnv, key: string, blob: Blob): Promise<void> {
  const customer = parseCustomerObjectKey(key);
  if (customer) {
    const api = await customerR2Api(env as Env, customer.ownerId);
    await api.ensureR2Bucket(GHOSTBUILD_CUSTOMER_BUCKET);
    await api.putR2Object(GHOSTBUILD_CUSTOMER_BUCKET, customer.remoteKey, blob, blob.type);
    return;
  }
  await env.APP_STORAGE.put(key, blob.stream(), {
    httpMetadata: {
      contentType: blob.type || 'application/octet-stream',
    },
  });
}

export async function deleteObject(env: ObjectStorageEnv, key: string): Promise<void> {
  const customer = parseCustomerObjectKey(key);
  if (customer) {
    const api = await customerR2Api(env as Env, customer.ownerId);
    await api.deleteR2Object(GHOSTBUILD_CUSTOMER_BUCKET, customer.remoteKey);
    return;
  }
  await env.APP_STORAGE.delete(key);
}

export async function objectResponse(env: ObjectStorageEnv, key: string): Promise<Response> {
  const customer = parseCustomerObjectKey(key);
  if (customer) {
    const api = await customerR2Api(env as Env, customer.ownerId);
    const response = await api.getR2Object(GHOSTBUILD_CUSTOMER_BUCKET, customer.remoteKey);
    if (!response) {
      return new Response('Not found', { status: 404 });
    }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { headers, status: response.status });
  }
  const object = await env.APP_STORAGE.get(key);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}

export async function objectHead(env: ObjectStorageEnv, key: string): Promise<{ size: number } | null> {
  const customer = parseCustomerObjectKey(key);
  if (customer) {
    const api = await customerR2Api(env as Env, customer.ownerId);
    const response = await api.headR2Object(GHOSTBUILD_CUSTOMER_BUCKET, customer.remoteKey);
    if (!response) {
      return null;
    }
    const size = Number(response.headers.get('content-length'));
    return { size: Number.isSafeInteger(size) && size >= 0 ? size : 0 };
  }
  const object = await env.APP_STORAGE.head(key);
  return object ? { size: object.size } : null;
}

export async function getObjectBytes(env: ObjectStorageEnv, key: string): Promise<Uint8Array | null> {
  const response = await objectResponse(env, key);
  return response.status === 404 ? null : new Uint8Array(await response.arrayBuffer());
}

export function storageUrl(key: string): string {
  return `/api/storage/${encodeURIComponent(key)}`;
}

function parseCustomerObjectKey(key: string): { ownerId: string; remoteKey: string } | null {
  const match = /^customer-r2\/v1\/([A-Za-z0-9_-]+)\/(.+)$/.exec(key);
  if (!match) {
    return null;
  }
  try {
    const ownerId = base64UrlDecode(match[1]);
    return ownerId && new TextEncoder().encode(ownerId).byteLength <= 128
      ? { ownerId, remoteKey: `${CUSTOMER_OBJECT_PREFIX}/${match[1]}/${match[2]}` }
      : null;
  } catch {
    return null;
  }
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}
