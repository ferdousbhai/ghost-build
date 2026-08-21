/**
 * Which container image a user's workspace runs, and who is allowed to serve it.
 *
 * Cloudflare pre-fetches and globally distributes images held in its own registry, but explicitly
 * does not cache images pulled from Docker Hub, Amazon ECR, or Google Artifact Registry. So an
 * image in the *user's own* `registry.cloudflare.com` namespace starts materially faster than the
 * same bytes on Docker Hub, on top of already carrying the pinned toolchain and a warm pnpm store.
 *
 * That registry is strictly account-scoped: repository names are `<account_id>/<image>`, every
 * `/v2/` path refuses anonymous access, and a pull credential is minted for exactly one account.
 * There is no cross-account, public, or shared namespace to point at. So this is not one global
 * image reference — it is per account, and an account that does not have the image yet falls back
 * to the public base image, which is correct and merely slower.
 */

export const CLOUDFLARE_REGISTRY_HOST = 'registry.cloudflare.com';
export const GHOSTBUILD_WORKSPACE_IMAGE_REPOSITORY = 'ghostbuild-workspace';

/**
 * The workspace image built by `scripts/build-user-workspace-image.mjs`. The tag names what the
 * image carries; the digest is what actually gets pinned, because a container application is
 * provisioned into accounts Ghostbuild does not control and a moving tag there would silently
 * change every user's workspace.
 */
const GHOSTBUILD_WORKSPACE_IMAGE_TAG = '7d54afd24f34-11.14.0';
export const GHOSTBUILD_WORKSPACE_IMAGE_DIGEST =
  'sha256:04c1a5baadfde1711fee2bcf7e468287f8db023416ba8c5533a0ef3030cc4d8c';

/**
 * Where `scripts/publish-workspace-image-blobs.mjs` puts the mirrored image, and where
 * provisioning reads it from. A canary test pins these against the script so the writer and the
 * reader cannot drift into a bucket that looks empty.
 */
export const WORKSPACE_IMAGE_MANIFEST_KEY = 'workspace-image/manifest.json';
export const workspaceImageBlobKey = (digest: string): string => `workspace-image/blobs/${digest}`;

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const DOCKER_HUB_IMAGE = /^docker\.io\/[a-z0-9._/-]+:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/;
const CLOUDFLARE_IMAGE =
  /^registry\.cloudflare\.com\/(?<account>[0-9a-f]{32})\/[a-z0-9._/-]+:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/i;

/**
 * The reference for an account, or null when the id is not one Cloudflare could have issued.
 *
 * Total rather than throwing, because the staleness predicate calls this on every session mint: a
 * malformed row must read as "not on the expected image" and re-provision, not take down capability
 * minting for that user.
 */
export function cloudflareWorkspaceImageReferenceOrNull(accountId: string): string | null {
  return ACCOUNT_ID.test(accountId) ? cloudflareWorkspaceImageReference(accountId) : null;
}

export function cloudflareWorkspaceImageReference(accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) {
    throw new Error('A Cloudflare workspace image reference needs a 32-character hexadecimal account id.');
  }
  return (
    `${CLOUDFLARE_REGISTRY_HOST}/${accountId.toLowerCase()}/${GHOSTBUILD_WORKSPACE_IMAGE_REPOSITORY}` +
    `:${GHOSTBUILD_WORKSPACE_IMAGE_TAG}@${GHOSTBUILD_WORKSPACE_IMAGE_DIGEST}`
  );
}

/**
 * Why this image reference may not reach a container application, or null when it may.
 *
 * Every reference must be immutable *and* servable by this account. The account check is the
 * load-bearing half: the Containers REST API does not validate the image string at all, so a
 * reference naming another account's registry namespace would be accepted here and then fail at
 * pull time with an authentication error nobody could diagnose.
 *
 * Returns the reason rather than throwing so the one caller can raise its own boundary error
 * without catching and re-wrapping a generic one.
 */
export function workspaceImageAdmissionError(image: string, accountId: string): string | null {
  if (DOCKER_HUB_IMAGE.test(image)) {
    return null;
  }
  const account = CLOUDFLARE_IMAGE.exec(image)?.groups?.account;
  if (!account) {
    return 'The workspace Sandbox image is not immutable.';
  }
  if (account.toLowerCase() !== accountId.toLowerCase()) {
    return 'The workspace Sandbox image belongs to a different Cloudflare account.';
  }
  return null;
}
