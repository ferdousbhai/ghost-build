import { describe, expect, it, vi } from 'vitest';

import { checkRuntimeArtifacts, errorReport, parseRuntimeArtifactPins } from './check-runtime-artifacts.mjs';

const sandboxDigest = `sha256:${'a'.repeat(64)}`;
const computerdDigest = `sha256:${'b'.repeat(64)}`;

function pins() {
  return parseRuntimeArtifactPins({
    packageJson: JSON.stringify({
      dependencies: { '@cloudflare/sandbox': '0.12.4', '@cloudflare/computer': '0.1.1' },
    }),
    provisionerSource: `const IMAGE = 'docker.io/cloudflare/sandbox:0.12.4@${sandboxDigest}';`,
    toolchainSource: `const COMPUTERD_LAYER_DIGEST = '${computerdDigest}';`,
  });
}

function registryFetch({ sandbox = sandboxDigest, layers = [computerdDigest] } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/token?')) {
      return Response.json({ token: 'registry-token' });
    }
    if (url.includes('registry-1.docker.io')) {
      return Response.json({ schemaVersion: 2, layers: [] }, { headers: { 'docker-content-digest': sandbox } });
    }
    return Response.json({ schemaVersion: 2, layers: layers.map((digest) => ({ digest })) });
  });
}

describe('runtime artifact monitoring', () => {
  it('derives registry tags from the exact SDK dependency versions', () => {
    expect(pins()).toEqual({
      sandbox: {
        name: 'Cloudflare Sandbox image',
        repository: 'cloudflare/sandbox',
        tag: '0.12.4',
        configuredTag: '0.12.4',
        pinnedDigest: sandboxDigest,
      },
      computerd: {
        name: 'Cloudflare computerd layer',
        repository: 'cloudflare/computer-computerd-linux-x64',
        tag: '0.1.1',
        pinnedDigest: computerdDigest,
      },
    });
  });

  it('reports current pins when both official registry artifacts match', async () => {
    const fetchImpl = registryFetch();
    const result = await checkRuntimeArtifacts(pins(), fetchImpl);

    expect(result.status).toBe('current');
    expect(result.results).toHaveLength(2);
    expect(result.results.every(({ status }: { status: string }) => status === 'current')).toBe(true);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('reports digest drift without hiding the published replacements', async () => {
    const publishedSandbox = `sha256:${'c'.repeat(64)}`;
    const publishedComputerd = `sha256:${'d'.repeat(64)}`;
    const result = await checkRuntimeArtifacts(
      pins(),
      registryFetch({ sandbox: publishedSandbox, layers: [publishedComputerd] }),
    );

    expect(result.status).toBe('drift');
    expect(result.results.map(({ remoteDigest }: { remoteDigest?: string }) => remoteDigest)).toEqual([
      publishedSandbox,
      publishedComputerd,
    ]);
    expect(result.markdown).toContain('Runtime artifact pins need attention');
  });

  it('requires review when the computerd image layout stops being a single layer', async () => {
    const result = await checkRuntimeArtifacts(
      pins(),
      registryFetch({ layers: [computerdDigest, `sha256:${'e'.repeat(64)}`] }),
    );

    expect(result.status).toBe('drift');
    expect(result.results[1]).toMatchObject({ remoteDigest: undefined, status: 'drift' });
    expect(result.results[1]?.detail).toContain('2 layers');
  });

  it('does not render an untrusted computerd digest', async () => {
    const result = await checkRuntimeArtifacts(pins(), registryFetch({ layers: ['<script>alert(1)</script>'] }));

    expect(result.status).toBe('drift');
    expect(result.results[1]).toMatchObject({ remoteDigest: undefined, status: 'drift' });
    expect(result.markdown).not.toContain('<script>');
  });

  it('renders operational failures for the same tracking issue', () => {
    const result = errorReport(new Error('registry unavailable'));

    expect(result.status).toBe('error');
    expect(result.markdown).toContain('registry unavailable');
  });
});
