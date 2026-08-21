/**
 * Upload an exported OCI image layout into the Ghostbuild-owned R2 bucket that provisioning
 * copies from.
 *
 * Why R2 and not "just point every user at one registry": Cloudflare's registry is account-scoped
 * — repository names are `<account_id>/<image>`, every `/v2/` path refuses anonymous reads, and a
 * credential is minted for exactly one account. There is no shared namespace, and no server-side
 * copy or import API, so the bytes have to be pushed into each user's own namespace by a client.
 * R2 is where that client reads them from, and a binding needs no long-lived credential.
 *
 * The layout must come from `docker buildx --output type=oci`, never from `docker save` or a
 * `docker pull`/`push` round trip: those re-serialize the manifest and change its digest, and the
 * digest is what a provisioned container application pins.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const IMAGE_BLOB_BUCKET = 'ghostbuild-workspace-image';
/** Key layout in the bucket. `manifest` names the image; blobs are content-addressed. */
export const MANIFEST_KEY = 'workspace-image/manifest.json';
export const blobKey = (digest) => `workspace-image/blobs/${digest}`;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REFERENCE_MODULE = 'app/lib/.server/cloudflare/workspace-image-reference.ts';

/**
 * Injected as two narrow readers rather than node's overloaded `readFileSync`, so a caller (and a
 * test) can supply them without matching that overload set.
 */
export function readOciLayout(
  layoutDirectory,
  readText = (path) => readFileSync(path, 'utf8'),
  readDirectory = (path) => readdirSync(path),
) {
  const index = JSON.parse(readText(resolve(layoutDirectory, 'index.json')));
  const entries = Array.isArray(index.manifests) ? index.manifests : [];
  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one manifest in the OCI layout, found ${entries.length}. ` +
        'Build with --provenance=false and a single --platform, so the index is not a multi-arch list.',
    );
  }
  const [descriptor] = entries;
  if (!DIGEST.test(descriptor.digest ?? '')) {
    throw new Error('The OCI index does not name a sha256 manifest digest.');
  }
  const manifestPath = resolve(layoutDirectory, 'blobs', 'sha256', descriptor.digest.slice('sha256:'.length));
  const manifest = JSON.parse(readText(manifestPath));
  const referenced = [manifest.config, ...(manifest.layers ?? [])];
  for (const blob of referenced) {
    if (!DIGEST.test(blob?.digest ?? '')) {
      throw new Error('The image manifest references a blob without a sha256 digest.');
    }
  }
  // Every blob the manifest names must be present, or a provisioned image would be unpullable in
  // a way that only shows up at container start.
  const present = new Set(readDirectory(resolve(layoutDirectory, 'blobs', 'sha256')));
  const missing = referenced.filter((blob) => !present.has(blob.digest.slice('sha256:'.length)));
  if (missing.length > 0) {
    throw new Error(`The OCI layout is missing ${missing.length} referenced blob(s).`);
  }
  return { manifestDigest: descriptor.digest, mediaType: descriptor.mediaType, referenced };
}

/**
 * A stale `CLOUDFLARE_API_TOKEN` silently overrides Wrangler's valid OAuth session, so it is
 * removed rather than set to `undefined` — spawn stringifies an `undefined` env value, and
 * Wrangler then authenticates with the literal token "undefined".
 */
function wranglerEnvironment() {
  const environment = { ...process.env };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_API_KEY;
  return environment;
}

/**
 * Uploads retry because a mirror is ~20 sequential Wrangler invocations over several minutes, and
 * the OAuth session behind them is refreshed by each subprocess independently. A single blob has
 * been observed failing with a 401 mid-run while the ones on either side succeeded; aborting the
 * whole transfer for that is worse than trying again. A credential that is genuinely gone still
 * fails, just after saying so three times.
 */
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAY_MS = 3_000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function put(key, filePath) {
  let failure = '';
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    const result = spawnSync(
      'pnpm',
      ['exec', 'wrangler', 'r2', 'object', 'put', `${IMAGE_BLOB_BUCKET}/${key}`, '--file', filePath, '--remote'],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: wranglerEnvironment() },
    );
    if (result.status === 0) {
      return attempt;
    }
    failure = (result.stderr || result.stdout || '').trim().slice(-500);
    if (attempt < UPLOAD_ATTEMPTS) {
      sleepSync(UPLOAD_RETRY_DELAY_MS);
    }
  }
  throw new Error(`Uploading ${key} failed after ${UPLOAD_ATTEMPTS} attempts: ${failure}`);
}

async function main() {
  const layoutDirectory = process.argv[2];
  if (!layoutDirectory) {
    throw new Error('Usage: node scripts/publish-workspace-image-blobs.mjs <oci-layout-directory>');
  }
  const layout = readOciLayout(layoutDirectory);
  console.log(`Manifest ${layout.manifestDigest} (${layout.mediaType})`);
  console.log(`${layout.referenced.length} blobs to mirror\n`);

  for (const [index, blob] of layout.referenced.entries()) {
    const file = resolve(layoutDirectory, 'blobs', 'sha256', blob.digest.slice('sha256:'.length));
    process.stdout.write(
      `  [${index + 1}/${layout.referenced.length}] ${blob.digest.slice(0, 19)}… ${(blob.size / 1e6).toFixed(1)} MB `,
    );
    const attempts = put(blobKey(blob.digest), file);
    console.log(attempts === 1 ? 'ok' : `ok (after ${attempts} attempts)`);
  }

  const manifestFile = resolve(layoutDirectory, 'blobs', 'sha256', layout.manifestDigest.slice('sha256:'.length));
  put(MANIFEST_KEY, manifestFile);
  console.log(`\nManifest uploaded: ${layout.manifestDigest}`);

  // The image build is not reproducible — `apt-get update` and the npm/GHCR fetches see different
  // upstream state on every run — so an identical Dockerfile still yields a new digest. That makes
  // "rebuild" and "re-pin" a pair: a pin left pointing at a previous build names blobs this bucket
  // no longer serves, and the failure shows up as an unpullable image at container start.
  const pinned = readFileSync(REFERENCE_MODULE, 'utf8').match(/'(sha256:[a-f0-9]{64})'/)?.[1];
  if (pinned !== layout.manifestDigest) {
    console.log(
      `\nGHOSTBUILD_WORKSPACE_IMAGE_DIGEST still names ${pinned ?? 'nothing'}.\n` +
        `Update it in ${REFERENCE_MODULE} to the digest above before deploying.`,
    );
  } else {
    console.log('GHOSTBUILD_WORKSPACE_IMAGE_DIGEST already names it.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
