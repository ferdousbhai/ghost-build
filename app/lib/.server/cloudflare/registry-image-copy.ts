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

async function blobExists(target: RegistryTarget, digest: string): Promise<boolean> {
  const response = await target.fetch(`${target.baseUrl}/v2/${target.repository}/blobs/${digest}`, {
    method: 'HEAD',
    headers: { authorization: target.authorization },
  });
  if (response.status === 200) {
    return true;
  }
  if (response.status === 404) {
    return false;
  }
  throw new RegistryCopyError('blob HEAD', response.status, await detail(response));
}

async function uploadBlob(
  target: RegistryTarget,
  blob: ImageBlobDescriptor,
  source: ImageBlobSource,
  chunkBytes: number,
): Promise<void> {
  const started = await target.fetch(`${target.baseUrl}/v2/${target.repository}/blobs/uploads/`, {
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
    const response = await target.fetch(location, {
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
  const finished = await target.fetch(location, {
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

  const response = await args.target.fetch(
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
