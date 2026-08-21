import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GHOSTBUILD_WORKSPACE_IMAGE_DIGEST,
  WORKSPACE_IMAGE_MANIFEST_KEY,
  workspaceImageBlobKey,
  workspaceImageAdmissionError,
  cloudflareWorkspaceImageReference,
} from './workspace-image-reference';

const ACCOUNT = '0af9e0921b880657d84a6c07307f8aef';
const OTHER = 'ffffffffffffffffffffffffffffffff';
const BASE = `docker.io/cloudflare/sandbox:0.13.0-next.724.1@sha256:${'d'.repeat(64)}`;

describe('workspace image reference', () => {
  it('builds a digest-pinned reference in the account it will be pulled from', () => {
    expect(cloudflareWorkspaceImageReference(ACCOUNT)).toBe(
      `registry.cloudflare.com/${ACCOUNT}/ghostbuild-workspace:7d54afd24f34-11.14.0@${GHOSTBUILD_WORKSPACE_IMAGE_DIGEST}`,
    );
  });

  it.each(['not-hex', '', 'abc', `${ACCOUNT}extra`])('refuses a malformed account id: %s', (bad) => {
    expect(() => cloudflareWorkspaceImageReference(bad)).toThrow(/account id/);
  });
});

describe('image admission', () => {
  it('accepts the digest-pinned public base image', () => {
    expect(workspaceImageAdmissionError(BASE, ACCOUNT)).toBeNull();
  });

  it("accepts this account's own Cloudflare registry image", () => {
    expect(workspaceImageAdmissionError(cloudflareWorkspaceImageReference(ACCOUNT), ACCOUNT)).toBeNull();
  });

  it("refuses another account's registry namespace", () => {
    // The Containers REST API declares `image` as a bare string with no validation, so nothing
    // downstream catches this. The pull would fail with an authentication error instead.
    expect(workspaceImageAdmissionError(cloudflareWorkspaceImageReference(OTHER), ACCOUNT)).toMatch(
      /different Cloudflare account/,
    );
  });

  it.each([
    ['a mutable tag with no digest', `registry.cloudflare.com/${ACCOUNT}/ghostbuild-workspace:latest`],
    ['a mutable Docker Hub tag', 'docker.io/cloudflare/sandbox:0.13.0'],
    ['an unknown registry', `ghcr.io/ghostbuild/workspace:v1@sha256:${'a'.repeat(64)}`],
    [
      'a registry-shaped host suffix attack',
      `registry.cloudflare.com.evil.test/${ACCOUNT}/x:v1@sha256:${'a'.repeat(64)}`,
    ],
  ])('refuses %s', (_name, image) => {
    expect(workspaceImageAdmissionError(image, ACCOUNT)).not.toBeNull();
  });
});

describe('blob store key layout', () => {
  it('agrees with the script that writes the bucket', () => {
    // The uploader is a plain .mjs script and cannot import this module, so the two halves of the
    // contract are pinned against each other here. Drift would leave provisioning reading from a
    // prefix nothing was ever written to, which looks exactly like "this account has no image".
    const script = readFileSync('scripts/publish-workspace-image-blobs.mjs', 'utf8');
    expect(script).toContain(`'${WORKSPACE_IMAGE_MANIFEST_KEY}'`);
    expect(script).toContain('`workspace-image/blobs/${digest}`');
    expect(workspaceImageBlobKey('sha256:abc')).toBe('workspace-image/blobs/sha256:abc');
  });
});
