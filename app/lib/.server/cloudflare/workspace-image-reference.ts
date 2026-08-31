/**
 * Which container images a user's workspace is allowed to run.
 *
 * Every user's workspace runs Cloudflare's stock Sandbox image pulled straight from Docker Hub, so
 * this is now just the admission check the container-application call makes before it hands an
 * image string to the Containers REST API — the API does not validate it, so an image naming a
 * registry this account cannot pull would be accepted here and fail opaquely at pull time.
 */

const DOCKER_HUB_IMAGE = /^docker\.io\/[a-z0-9._/-]+:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/;
const CLOUDFLARE_IMAGE =
  /^registry\.cloudflare\.com\/(?<account>[0-9a-f]{32})\/[a-z0-9._/-]+:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/i;

/**
 * Why this image reference may not reach a container application, or null when it may.
 *
 * Every reference must be immutable *and* servable by this account. A Docker Hub image with a
 * pinned digest is always servable; a `registry.cloudflare.com` reference is servable only when it
 * names this account's own namespace, because a pull credential is minted for exactly one account.
 * Returns the reason rather than throwing so the one caller can raise its own boundary error.
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
