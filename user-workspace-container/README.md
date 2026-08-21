# User workspace container image

Every user workspace runs in this image. It exists so that a cold container starts _ready_: the
stock `cloudflare/sandbox` image has neither the pinned pnpm nor Cloudflare's `computerd`, and
container disk is wiped every time an instance sleeps, so without this image each cold start pays

- an `npm install --global pnpm@<pinned>` over the network,
- a GHCR token request plus a `computerd` layer download and extraction, and
- a `pnpm install` for the template's ~570 packages against a completely empty store.

The image bakes all three in. The runtime bootstrap in
[`user-workspace-runtime/src/container-toolchain.ts`](../user-workspace-runtime/src/container-toolchain.ts)
is unchanged and still correct — both of its commands are guarded on "is it already here?", so
against this image they short-circuit, and they remain the fallback if the image is ever rolled
back to stock.

## Registry: each account's own Cloudflare namespace

Cloudflare pre-fetches and globally distributes images held in **its own** registry, and states
plainly that it "does not cache images pulled from Docker Hub, Amazon ECR, or Google Artifact
Registry". So the image lives in `registry.cloudflare.com`, not Docker Hub.

That registry is strictly account-scoped, and this was verified rather than assumed: repository
names are `<account_id>/<image>`, every `/v2/` path returns `401 Basic realm=...` to an anonymous
client — including `/v2/_catalog` and an arbitrary account's namespace — and a credential is minted
for exactly one account. There is no cross-account, public, or shared namespace to point every user
at. (A `library/` namespace exists and Cloudflare publishes `computerd` through it, but it is gated
behind an undocumented `library_push` permission Cloudflare grants itself. Do not build on it.)

So there is no single global image reference. The image is resolved **per account** at provisioning:
if that account's registry already holds the pinned digest, its containers run it; otherwise they
run the stock public base image and the runtime bootstrap installs everything lazily. The fallback
is correct and merely slower, which is also what stops a registry outage from blocking provisioning.

## Publishing

Exactly one route, because a `docker save` or a `docker pull`/`push` round trip re-serializes the
manifest and changes its digest — and the digest is what a provisioned container application pins.
Only a buildx OCI export produces blobs whose digests match the manifest shipped with them.

```bash
pnpm run build:workspace-image:oci   # generate the Dockerfile, build, export the OCI layout
node scripts/publish-workspace-image-blobs.mjs user-workspace-container/.build/oci/layout
```

The build is **not reproducible** — `apt-get update` and the npm/GHCR fetches see different
upstream state on each run — so an unchanged Dockerfile still produces a new digest. Rebuilding and
re-pinning are therefore a pair; the publish script says so if you forget, because a pin left on a
previous build names blobs the bucket no longer serves and fails as an unpullable image at
container start.

The second command prints the manifest digest. Pin it in `GHOSTBUILD_WORKSPACE_IMAGE_DIGEST` in
[`workspace-image-reference.ts`](../app/lib/.server/cloudflare/workspace-image-reference.ts), and
update the tag beside it.

From there, provisioning does the rest: `UserCloudflareAccountApi.ensureWorkspaceImage` mints a
short-lived push credential from that user's own OAuth token and copies the blobs from R2 into
their registry namespace, skipping anything already present.

Measured layer sizes, compressed: base `cloudflare/sandbox` 220 MB (15 layers, largest 47.9 MB),
`computerd` 44 MB, pnpm ~10 MB, pre-warmed pnpm store 132 MB. Image storage is capped at 50 GB per
account and is not a billed dimension, so ~400 MB per account is 0.8% of the cap and costs nothing.

## Store pre-warm and lockfile drift

The pnpm store is warmed from `template/pnpm-lock.yaml` at build time. That is a cache, never a
correctness input: a project whose lockfile has moved on still installs correctly, it just fetches
the packages the store does not have yet. Republishing after a template dependency change is a
performance refresh, not a required step.
