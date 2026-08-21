import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { parseImageInputs, renderDockerfile, WORKSPACE_NODE_VERSION } from './build-user-workspace-image.mjs';

const base = 'docker.io/cloudflare/sandbox:1.2.3@sha256:' + 'a'.repeat(64);
const computerdDigest = `sha256:${'b'.repeat(64)}`;

function inputs() {
  return parseImageInputs({
    provisionerSource: `export const USER_WORKSPACE_SANDBOX_BASE_IMAGE = '${base}';`,
    toolchainSource: [
      `export const COMPUTERD_ROOT = '/opt/ghostbuild/computer';`,
      `const COMPUTERD_LAYER_DIGEST = '${computerdDigest}';`,
      `export const CONTAINER_PNPM_STORE_DIR = '/opt/ghostbuild/pnpm-store';`,
    ].join('\n'),
    computerSource: `export const GENERATED_PROJECT_PNPM_VERSION = '11.14.0';`,
  });
}

describe('workspace image inputs', () => {
  it('reads every pin from the source that already enforces it', () => {
    expect(inputs()).toEqual({
      base,
      computerdDigest,
      pnpmVersion: '11.14.0',
      computerdRoot: '/opt/ghostbuild/computer',
      pnpmStore: '/opt/ghostbuild/pnpm-store',
    });
  });

  it.each([
    ['base image', { provisionerSource: 'const nothing = 1;' }],
    ['computerd digest', { toolchainSource: `export const COMPUTERD_ROOT = '/opt/x';` }],
    ['pnpm version', { computerSource: 'const nothing = 1;' }],
  ])('refuses to render an image with no %s pin', (_name, override) => {
    expect(() =>
      parseImageInputs({
        provisionerSource: `const IMAGE = '${base}';`,
        toolchainSource: [
          `export const COMPUTERD_ROOT = '/opt/ghostbuild/computer';`,
          `const COMPUTERD_LAYER_DIGEST = '${computerdDigest}';`,
          `export const CONTAINER_PNPM_STORE_DIR = '/opt/ghostbuild/pnpm-store';`,
        ].join('\n'),
        computerSource: `export const GENERATED_PROJECT_PNPM_VERSION = '11.14.0';`,
        ...override,
      }),
    ).toThrow();
  });
});

describe('rendered Dockerfile', () => {
  const dockerfile = renderDockerfile(inputs());

  it('builds from the digest-pinned base image', () => {
    expect(dockerfile).toContain(`FROM ${base}`);
  });

  it('bakes in exactly what the cold-start bootstrap would otherwise fetch', () => {
    // Each of these is a network round trip the runtime pays on every cold container when the
    // image does not already carry it, so losing one silently reintroduces that cost.
    expect(dockerfile).toContain('npm install --global pnpm@11.14.0');
    expect(dockerfile).toContain(computerdDigest);
    expect(dockerfile).toContain('pnpm fetch --ignore-scripts --store-dir /opt/ghostbuild/pnpm-store');
  });

  it('warms the store without running dependency install scripts', () => {
    // The runtime install refuses to run them (`--ignore-scripts=true`). A store warm that runs
    // them anyway executes third-party code at image build time for no benefit: the store holds
    // tarballs, and scripts only matter when a package is linked into a node_modules.
    expect(dockerfile).toMatch(/pnpm fetch --ignore-scripts\b/);
  });

  it("disables pnpm's implicit pre-run install, which bricks the durable workspace", () => {
    // Inside /home/project that mount is the durable VFS, so an implicit install writes a whole
    // dependency tree into Durable Object storage and the workspace never recovers (#137). It
    // belongs in the image, out of reach of anything the model can edit in the project.
    expect(dockerfile).toContain('ENV npm_config_verify_deps_before_run=false');
  });

  it('ships a Node the generated project will actually accept', () => {
    // The base image ships Node 22 and generated projects declare engines.node >= 26 (#135). A
    // mismatch is a warning right up until a dependency needs 26, and then it is a hard failure
    // inside a container the user cannot upgrade.
    const engines: string = JSON.parse(readFileSync('template/package.json', 'utf8')).engines.node;
    const minimum = Number(/(\d+)/.exec(engines)?.[1]);

    expect(engines.startsWith('>=')).toBe(true);
    expect(Number(WORKSPACE_NODE_VERSION.split('.')[0])).toBeGreaterThanOrEqual(minimum);
    expect(dockerfile).toContain(`node-v${WORKSPACE_NODE_VERSION}-linux-x64.tar.gz`);
  });

  it('verifies the Node tarball against a published checksum before unpacking it', () => {
    expect(dockerfile).toMatch(/echo '[a-f0-9]{64}  \/tmp\/node\.tar\.gz' \| sha256sum -c -/);
    expect(dockerfile).toContain(`test "$(node --version)" = 'v${WORKSPACE_NODE_VERSION}'`);
  });

  it('installs Node before pnpm, so pnpm runs on the Node that will run it', () => {
    expect(dockerfile.indexOf('node.tar.gz')).toBeLessThan(dockerfile.indexOf('npm install --global pnpm'));
  });

  it('installs Node into its own prefix instead of over the base image', () => {
    // Unpacking Node over an existing Node merges two npm trees and leaves stale files, and the
    // resulting npm dies with "Class extends value undefined is not a constructor". A separate
    // prefix also leaves the base image's own Node intact.
    expect(dockerfile).toContain('tar -xzf /tmp/node.tar.gz -C /opt/ghostbuild/node --strip-components=1');
    expect(dockerfile).not.toContain('/tmp/node.tar.gz -C /usr/local');
    expect(dockerfile).toContain('ENV PATH=/opt/ghostbuild/node/bin:$PATH');
  });

  it('installs the shared library Node needs to load at all', () => {
    // Without it node exits with a missing libatomic.so.1, which names nothing about Node.
    expect(dockerfile).toContain('libatomic1');
  });

  it('verifies the computerd layer against its pinned digest before trusting it', () => {
    expect(dockerfile).toContain(`echo '${'b'.repeat(64)}  /tmp/computerd-layer.tgz' | sha256sum -c -`);
    expect(dockerfile).toContain('test -x /opt/ghostbuild/computer/usr/local/bin/computerd');
  });
});
