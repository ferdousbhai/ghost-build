export function allocateObjectKey(prefix: string): string {
  return `${prefix}/${crypto.randomUUID()}`;
}

export async function putObjectAtKey(env: Env, key: string, blob: Blob): Promise<void> {
  await env.APP_STORAGE.put(key, blob.stream(), {
    httpMetadata: {
      contentType: blob.type || 'application/octet-stream',
    },
  });
}

export async function deleteObject(env: Env, key: string): Promise<void> {
  await env.APP_STORAGE.delete(key);
}

export async function objectResponse(env: Env, key: string): Promise<Response> {
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

export function storageUrl(key: string): string {
  return `/api/storage/${encodeURIComponent(key)}`;
}
