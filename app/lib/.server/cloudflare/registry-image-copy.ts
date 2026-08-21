/**
 * Copy a container image into a Cloudflare registry namespace over the Docker Registry v2 API.
 *
 * Cloudflare's registry is account-scoped and offers no cross-account namespace, and its
 * Containers API has no import or server-side copy endpoint — `wrangler containers push` streams
 * layers out of a local Docker daemon, which a Worker does not have. So provisioning a user's
 * workspace image means speaking the registry protocol directly, reading blobs from a
 * Ghostbuild-owned store and writing them into the user's own namespace.
 *
 * Uploads are chunked rather than streamed, and that is a constraint rather than a preference.
 * The workspace image's largest layer is ~141 MB against a 128 MB Worker isolate memory limit, so
 * the whole blob can never be in memory at once. Chunking also sidesteps an untestable question:
 * a Worker sends a streaming request body with chunked transfer encoding, and a registry is
 * entitled to require `Content-Length` on a monolithic blob `PUT`. Every request this makes has a
 * known length.
 */

type ImageBlobDescriptor = { digest: string; size: number };

export type ImageBlobSource = {
  /** Bytes for the half-open range [start, end). Must return exactly that many bytes. */
  slice(digest: string, start: number, end: number): Promise<ArrayBuffer>;
};

type RegistryTarget = {
  /** Registry origin including scheme, e.g. `https://registry.cloudflare.com`. */
  baseUrl: string;
  /** Repository path, which on Cloudflare's registry is `<account_id>/<image>`. */
  repository: string;
  /** Complete Authorization header value; Cloudflare's registry speaks HTTP Basic, not bearer. */
  authorization: string;
  fetch: typeof fetch;
};

/**
 * Bytes per upload request. Comfortably inside the isolate memory limit even with the response
 * and the copy both resident, and large enough that a 141 MB layer is tens of requests rather
 * than thousands.
 */
export const DEFAULT_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export class RegistryCopyError extends Error {
  constructor(
    readonly step: string,
    readonly status: number,
    detail: string,
  ) {
    super(`Registry ${step} failed with HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'RegistryCopyError';
  }
}

/**
 * Take the injected fetch as a bare function, never as a method on the target.
 *
 * `target.fetch(url)` invokes it with `target` as its `this`, and the Workers runtime rejects the
 * global fetch called with a foreign receiver — "Illegal invocation", which surfaced only in
 * production because Node's fetch does not care what it is called on.
 */
function callFetch(target: RegistryTarget): typeof fetch {
  const { fetch: fetchImpl } = target;
  return (input, init) => fetchImpl(input, init);
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function requireDigest(digest: string): string {
  if (!DIGEST.test(digest)) {
    throw new Error(`Refusing to address a registry blob by a non-sha256 digest: ${digest}`);
  }
  return digest;
}

/** An upload `Location` may be returned relative, and may already carry a query string. */
function resolveLocation(baseUrl: string, location: string | null, step: string): URL {
  if (!location) {
    throw new RegistryCopyError(step, 0, 'response did not include a Location header');
  }
  return new URL(location, baseUrl);
}

async function detail(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Everything about a response worth knowing when it was not the status we expected.
 *
 * A `HEAD` carries no body, so an unexpected status is otherwise a bare number with nothing to
 * diagnose from — which is exactly how an HTTP 500 here cost a full deploy cycle and taught us
 * nothing. These headers say who answered: `cf-ray` and `server` separate an edge error page from
 * the registry itself, `www-authenticate` identifies a credential problem, and `location` plus
 * `redirected` reveal a hop to backing storage.
 */
export function responseDiagnostics(response: Response) {
  const header = (name: string) => response.headers.get(name) ?? '';
  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    redirected: response.redirected,
    cfRay: header('cf-ray'),
    server: header('server'),
    contentType: header('content-type'),
    wwwAuthenticate: header('www-authenticate'),
    dockerDistributionApi: header('docker-distribution-api-version'),
    location: header('location'),
  };
}

/**
 * Whether the registry already holds this blob.
 *
 * Advisory, never fatal. This is a skip-work check: uploading a blob the registry already has is
 * harmless because registries deduplicate by digest, so an unreadable answer costs bandwidth and
 * nothing else. Throwing here instead made an optimization load-bearing and abandoned the whole
 * copy over it. An unexpected status therefore reports "absent" and lets the upload proceed —
 * and the upload's failure, unlike a `HEAD`'s, carries a v2 error body worth reading.
 *
 * Redirects are not followed. A registry that answers a blob request with a hop to backing
 * storage is asserting the blob is there, and following it would replay the `HEAD` against a URL
 * signed for a different method, with the `Authorization` header stripped on the cross-origin hop.
 */
async function blobExists(target: RegistryTarget, digest: string): Promise<boolean> {
  const response = await callFetch(target)(`${target.baseUrl}/v2/${target.repository}/blobs/${digest}`, {
    method: 'HEAD',
    headers: { authorization: target.authorization },
    redirect: 'manual',
  });
  if (response.status === 200 || (response.status >= 300 && response.status < 400)) {
    return true;
  }
  if (response.status !== 404) {
    console.warn('Registry blob presence check was inconclusive; uploading the blob anyway', {
      digest,
      ...responseDiagnostics(response),
    });
  }
  return false;
}

async function uploadBlob(
  target: RegistryTarget,
  blob: ImageBlobDescriptor,
  source: ImageBlobSource,
  chunkBytes: number,
): Promise<void> {
  const started = await callFetch(target)(`${target.baseUrl}/v2/${target.repository}/blobs/uploads/`, {
    method: 'POST',
    headers: { authorization: target.authorization, 'content-length': '0' },
  });
  if (started.status !== 202) {
    throw new RegistryCopyError('blob upload start', started.status, await detail(started));
  }

  let location = resolveLocation(target.baseUrl, started.headers.get('location'), 'blob upload start');
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, blob.size);
    const chunk = await source.slice(blob.digest, offset, end);
    if (chunk.byteLength !== end - offset) {
      throw new Error(`Blob source returned ${chunk.byteLength} bytes for a ${end - offset} byte range.`);
    }
    const response = await callFetch(target)(location, {
      method: 'PATCH',
      headers: {
        authorization: target.authorization,
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.byteLength),
        // Inclusive range, per the Registry v2 chunked-upload contract.
        'content-range': `${offset}-${end - 1}`,
      },
      body: chunk,
    });
    if (response.status !== 202) {
      throw new RegistryCopyError('blob chunk upload', response.status, await detail(response));
    }
    location = resolveLocation(target.baseUrl, response.headers.get('location'), 'blob chunk upload');
  }

  // The registry assigns the upload's query string, so the digest has to be appended to it rather
  // than replace it.
  location.searchParams.set('digest', blob.digest);
  const finished = await callFetch(target)(location, {
    method: 'PUT',
    headers: { authorization: target.authorization, 'content-length': '0' },
  });
  if (finished.status !== 201) {
    throw new RegistryCopyError('blob upload completion', finished.status, await detail(finished));
  }
}

/**
 * Push every blob the manifest references, then the manifest itself.
 *
 * The manifest is written **verbatim**. Re-serializing it would change its digest, and the digest
 * is what a provisioned container application pins — a re-encoded manifest yields an image that
 * exists but that nothing is configured to pull.
 */
export async function copyImageToRegistry(args: {
  manifestBytes: Uint8Array;
  manifestMediaType: string;
  manifestDigest: string;
  blobs: readonly ImageBlobDescriptor[];
  source: ImageBlobSource;
  target: RegistryTarget;
  chunkBytes?: number;
}): Promise<{ uploaded: number; skipped: number }> {
  requireDigest(args.manifestDigest);
  const chunkBytes = args.chunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES;
  let uploaded = 0;
  let skipped = 0;

  for (const blob of args.blobs) {
    requireDigest(blob.digest);
    if (await blobExists(args.target, blob.digest)) {
      skipped += 1;
      continue;
    }
    await uploadBlob(args.target, blob, args.source, chunkBytes);
    uploaded += 1;
  }

  const response = await callFetch(args.target)(
    `${args.target.baseUrl}/v2/${args.target.repository}/manifests/${args.manifestDigest}`,
    {
      method: 'PUT',
      headers: {
        authorization: args.target.authorization,
        'content-type': args.manifestMediaType,
        'content-length': String(args.manifestBytes.byteLength),
      },
      body: args.manifestBytes.slice().buffer,
    },
  );
  if (response.status !== 201) {
    throw new RegistryCopyError('manifest upload', response.status, await detail(response));
  }
  return { uploaded, skipped };
}
