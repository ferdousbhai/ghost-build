import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UPLOAD_CHUNK_BYTES,
  RegistryCopyError,
  copyImageToRegistry,
  type ImageBlobSource,
} from './registry-image-copy';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_M = `sha256:${'e'.repeat(64)}`;
const MANIFEST_BYTES = new Uint8Array([1, 2, 3]);

/** Copy into a fresh ArrayBuffer so the source contract is satisfied without asserting a type. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

function bytesSource(bytes: Record<string, Uint8Array>): ImageBlobSource {
  return {
    slice: async (digest, start, end) => toArrayBuffer(bytes[digest]?.subarray(start, end) ?? new Uint8Array()),
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function requestBytes(init: RequestInit | undefined): Uint8Array {
  return init?.body instanceof ArrayBuffer ? new Uint8Array(init.body) : new Uint8Array();
}

/** A minimal in-memory Registry v2 that enforces the parts this client depends on. */
function fakeRegistry(options: { existing?: Set<string> } = {}) {
  const existing = options.existing ?? new Set<string>();
  const uploads = new Map<string, Uint8Array>();
  const stored = new Map<string, Uint8Array>();
  const requests: string[] = [];
  let nextUpload = 0;

  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url.pathname}`);
    if (!headers.get('authorization')) {
      return new Response('unauthorized', { status: 401 });
    }

    if (method === 'HEAD' && url.pathname.includes('/blobs/')) {
      const digest = url.pathname.split('/blobs/')[1] ?? '';
      return new Response(null, { status: existing.has(digest) ? 200 : 404 });
    }
    if (method === 'POST' && url.pathname.endsWith('/blobs/uploads/')) {
      const id = `upload-${nextUpload++}`;
      uploads.set(id, new Uint8Array());
      // Return a *relative* location carrying a query string, which is what real registries do.
      return new Response(null, { status: 202, headers: { location: `/v2/upload/${id}?_state=opaque` } });
    }
    if (method === 'PATCH') {
      const id = url.pathname.split('/').at(-1) ?? '';
      const previous = uploads.get(id) ?? new Uint8Array();
      const start = Number(headers.get('content-range')?.split('-')[0]);
      if (start !== previous.byteLength) {
        return new Response(`out of order chunk at ${start}, expected ${previous.byteLength}`, { status: 416 });
      }
      const chunk = requestBytes(init);
      const merged = new Uint8Array(previous.byteLength + chunk.byteLength);
      merged.set(previous);
      merged.set(chunk, previous.byteLength);
      uploads.set(id, merged);
      return new Response(null, { status: 202, headers: { location: `/v2/upload/${id}?_state=opaque` } });
    }
    if (method === 'PUT' && url.pathname.startsWith('/v2/upload/')) {
      const id = url.pathname.split('/').at(-1) ?? '';
      const digest = url.searchParams.get('digest');
      if (!digest) {
        return new Response('missing digest', { status: 400 });
      }
      // The opaque state the registry assigned must survive alongside the digest.
      if (url.searchParams.get('_state') !== 'opaque') {
        return new Response('upload state was discarded', { status: 400 });
      }
      stored.set(digest, uploads.get(id) ?? new Uint8Array());
      return new Response(null, { status: 201 });
    }
    if (method === 'PUT' && url.pathname.includes('/manifests/')) {
      stored.set(url.pathname.split('/manifests/')[1] ?? '', requestBytes(init));
      return new Response(null, { status: 201 });
    }
    return new Response('unexpected', { status: 500 });
  });

  return { fetchImpl, stored, requests };
}

const MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';

/**
 * Every unit case copies one image into one fake registry; only the blobs, the source, and the
 * chunk size distinguish them, so the manifest and the target stay here.
 */
function copyToFakeRegistry(
  fetchImpl: typeof fetch,
  blobs: ReadonlyArray<{ digest: string; size: number }>,
  source: ImageBlobSource,
  chunkBytes?: number,
) {
  return copyImageToRegistry({
    manifestBytes: MANIFEST_BYTES,
    manifestMediaType: MANIFEST_MEDIA_TYPE,
    manifestDigest: DIGEST_M,
    blobs,
    source,
    target: {
      baseUrl: 'https://registry.test',
      repository: 'acct/image',
      authorization: 'Basic dGVzdA==',
      fetch: fetchImpl,
    },
    chunkBytes,
  });
}

describe('registry image copy', () => {
  it('uploads a blob in ordered chunks and completes it by digest', async () => {
    const payload = new Uint8Array(2_500).map((_, index) => index % 251);
    const { fetchImpl, stored } = fakeRegistry();

    const result = await copyToFakeRegistry(
      fetchImpl,
      [{ digest: DIGEST_A, size: payload.byteLength }],
      bytesSource({ [DIGEST_A]: payload }),
      1_000,
    );

    expect(result).toEqual({ uploaded: 1, skipped: 0 });
    expect(stored.get(DIGEST_A)).toEqual(payload);
    expect(stored.get(DIGEST_M)).toEqual(MANIFEST_BYTES);
  });

  it('skips a blob the account already holds', async () => {
    // Re-provisioning the same image must not re-upload 400 MB; a HEAD is the whole cost.
    const { fetchImpl, requests } = fakeRegistry({ existing: new Set([DIGEST_A]) });

    const result = await copyToFakeRegistry(
      fetchImpl,
      [{ digest: DIGEST_A, size: 10 }],
      bytesSource({ [DIGEST_A]: new Uint8Array(10) }),
    );

    expect(result).toEqual({ uploaded: 0, skipped: 1 });
    expect(requests.filter((request) => request.startsWith('PATCH'))).toHaveLength(0);
  });

  it('never holds a whole layer in memory', async () => {
    // The largest workspace layer is ~141 MB against a 128 MB isolate limit, so the chunk size is
    // a correctness constraint, not a tuning knob.
    const size = 40 * 1024 * 1024;
    const requested: number[] = [];
    const { fetchImpl } = fakeRegistry();
    const source: ImageBlobSource = {
      slice: async (_digest, start, end) => {
        requested.push(end - start);
        return new ArrayBuffer(end - start);
      },
    };

    await copyToFakeRegistry(fetchImpl, [{ digest: DIGEST_A, size }], source);

    expect(Math.max(...requested)).toBeLessThanOrEqual(DEFAULT_UPLOAD_CHUNK_BYTES);
    expect(requested.reduce((a, b) => a + b, 0)).toBe(size);
  });

  it('never invokes the injected fetch as a method on the target', async () => {
    // `target.fetch(url)` passes `target` as `this`, and the Workers runtime rejects the global
    // fetch called with a foreign receiver — "Illegal invocation". Node's fetch does not care, so
    // this shipped and only failed in production. Asserting the receiver is what pins it.
    // Whatever the runtime binds as the receiver: `undefined` when called as a plain function,
    // the target object when called as a method.
    type FetchReceiver = object | undefined;
    const receivers: FetchReceiver[] = [];
    const { fetchImpl, stored } = fakeRegistry();
    function recordingFetch(this: FetchReceiver, input: RequestInfo | URL, init?: RequestInit) {
      receivers.push(this);
      return fetchImpl(input, init);
    }

    await copyImageToRegistry({
      manifestBytes: new Uint8Array([1]),
      manifestMediaType: 'application/vnd.oci.image.manifest.v1+json',
      manifestDigest: DIGEST_M,
      blobs: [{ digest: DIGEST_A, size: 4 }],
      source: bytesSource({ [DIGEST_A]: new Uint8Array([1, 2, 3, 4]) }),
      target: {
        baseUrl: 'https://registry.test',
        repository: 'acct/image',
        authorization: 'Basic dGVzdA==',
        fetch: recordingFetch,
      },
    });

    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((receiver) => receiver === undefined)).toBe(true);
    expect(stored.has(DIGEST_M)).toBe(true);
  });

  it('refuses to address a blob by anything but a sha256 digest', async () => {
    const { fetchImpl } = fakeRegistry();
    await expect(copyToFakeRegistry(fetchImpl, [{ digest: 'latest', size: 1 }], bytesSource({}))).rejects.toThrow(
      /non-sha256 digest/,
    );
  });

  it('reports which registry step failed rather than a bare status', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('boom', { status: 500 }));
    await expect(
      copyToFakeRegistry(fetchImpl, [{ digest: DIGEST_A, size: 1 }], bytesSource({ [DIGEST_A]: new Uint8Array(1) })),
    ).rejects.toBeInstanceOf(RegistryCopyError);
  });

  it('rejects a source that returns the wrong number of bytes for a range', async () => {
    const { fetchImpl } = fakeRegistry();
    const source: ImageBlobSource = { slice: async () => new ArrayBuffer(5) };
    await expect(copyToFakeRegistry(fetchImpl, [{ digest: DIGEST_A, size: 100 }], source)).rejects.toThrow(
      /returned 5 bytes/,
    );
  });
});

/**
 * The fake above encodes what I believe the protocol requires. This runs the same client against
 * a real Registry v2 implementation, which is the only thing that can tell me the belief is right.
 * Skipped unless a local registry is running, so it never breaks a checkout that has no Docker.
 */
const OCI_LAYOUT = 'user-workspace-container/.build/oci/layout';
const layoutPresent = existsSync(resolve(OCI_LAYOUT, 'index.json'));
const LOCAL_REGISTRY = 'http://localhost:5555';
const localRegistryUp = await fetch(`${LOCAL_REGISTRY}/v2/`)
  .then((response) => response.ok)
  .catch(() => false);

describe.skipIf(!localRegistryUp || !layoutPresent)('against a real Registry v2', () => {
  it('copies the real workspace image and preserves its manifest digest', async () => {
    const index = JSON.parse(readFileSync(resolve(OCI_LAYOUT, 'index.json'), 'utf8'));
    const manifestDigest: string = index.manifests[0].digest;
    const blobPath = (digest: string) => resolve(OCI_LAYOUT, 'blobs', 'sha256', digest.slice('sha256:'.length));
    const manifestBytes = new Uint8Array(readFileSync(blobPath(manifestDigest)));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));

    const result = await copyImageToRegistry({
      manifestBytes,
      manifestMediaType: manifest.mediaType,
      manifestDigest,
      blobs: [manifest.config, ...manifest.layers].map(({ digest, size }) => ({ digest, size })),
      source: {
        slice: async (digest, start, end) =>
          toArrayBuffer(new Uint8Array(readFileSync(blobPath(digest)).subarray(start, end))),
      },
      target: {
        baseUrl: LOCAL_REGISTRY,
        repository: 'acct/ghostbuild-workspace',
        authorization: 'Basic dGVzdDp0ZXN0',
        fetch,
      },
    });

    // Re-run safe: a second run legitimately skips every blob. What must hold either way is
    // that the copy accounted for all of them and the manifest lands at the pinned digest.
    expect(result.uploaded + result.skipped).toBe(manifest.layers.length + 1);

    // The registry must serve the manifest back at the exact digest we pinned. Anything else means
    // the bytes were re-serialized and the provisioner's pin would dangle.
    const head = await fetch(`${LOCAL_REGISTRY}/v2/acct/ghostbuild-workspace/manifests/${manifestDigest}`, {
      method: 'HEAD',
      headers: { accept: manifest.mediaType },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('docker-content-digest')).toBe(manifestDigest);
  }, 300_000);
});
