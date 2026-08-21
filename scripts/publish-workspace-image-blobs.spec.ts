import { describe, expect, it } from 'vitest';

import { MANIFEST_KEY, blobKey, readOciLayout } from './publish-workspace-image-blobs.mjs';

const MANIFEST_DIGEST = `sha256:${'e'.repeat(64)}`;
const CONFIG_DIGEST = `sha256:${'c'.repeat(64)}`;
const LAYER_DIGEST = `sha256:${'1'.repeat(64)}`;

function reader(overrides: { index?: unknown; manifest?: unknown; present?: string[] } = {}) {
  const manifest = overrides.manifest ?? {
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: CONFIG_DIGEST, size: 10 },
    layers: [{ digest: LAYER_DIGEST, size: 20 }],
  };
  const index = overrides.index ?? {
    manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: MANIFEST_DIGEST, size: 3 }],
  };
  const present = overrides.present ?? [CONFIG_DIGEST, LAYER_DIGEST, MANIFEST_DIGEST].map((digest) => digest.slice(7));
  return () =>
    readOciLayout(
      '/layout',
      (path: string) => JSON.stringify(path.endsWith('index.json') ? index : manifest),
      () => present,
    );
}

describe('OCI layout reading', () => {
  it('names the manifest and every blob it references', () => {
    const result = reader()();

    expect(result.manifestDigest).toBe(MANIFEST_DIGEST);
    expect(result.referenced.map((blob: { digest: string }) => blob.digest)).toEqual([CONFIG_DIGEST, LAYER_DIGEST]);
  });

  it('refuses a multi-arch index', () => {
    // A multi-arch index means two manifests and two digests, and the provisioner pins exactly
    // one. Build with a single --platform and --provenance=false.
    expect(() => reader({ index: { manifests: [{ digest: MANIFEST_DIGEST }, { digest: CONFIG_DIGEST }] } })()).toThrow(
      /exactly one manifest/,
    );
  });

  it('refuses a layout that is missing a blob the manifest references', () => {
    // Uploading an incomplete image produces one that exists but cannot be pulled — a failure
    // that would otherwise surface only when a container tries to start.
    expect(() => reader({ present: [MANIFEST_DIGEST.slice(7)] })()).toThrow(/missing 2 referenced/);
  });

  it('refuses a manifest that addresses a blob by anything but a sha256 digest', () => {
    expect(() => reader({ manifest: { mediaType: 'x', config: { digest: 'latest', size: 1 }, layers: [] } })()).toThrow(
      /without a sha256 digest/,
    );
  });
});

describe('bucket key layout', () => {
  it('addresses blobs by digest under one prefix', () => {
    expect(blobKey(LAYER_DIGEST)).toBe(`workspace-image/blobs/${LAYER_DIGEST}`);
    expect(MANIFEST_KEY).toBe('workspace-image/manifest.json');
  });
});
