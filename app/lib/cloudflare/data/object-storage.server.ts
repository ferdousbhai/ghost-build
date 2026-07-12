export async function putObject(env: Env, prefix: string, blob: Blob): Promise<string> {
  const key = `${prefix}/${crypto.randomUUID()}`;
  await env.APP_STORAGE.put(key, await blob.arrayBuffer(), {
    httpMetadata: {
      contentType: blob.type || 'application/octet-stream',
    },
  });
  return key;
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
  return new Response(object.body, { headers });
}

export function storageUrl(key: string): string {
  return `/api/storage/${encodeURIComponent(key)}`;
}
