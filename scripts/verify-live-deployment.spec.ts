import { describe, expect, it, vi } from 'vitest';
import {
  globalpingRequest,
  globalMeasurementErrors,
  validateExpectedSha,
  verifyGlobalDeployment,
  verifyLocalDeployment,
  versionResponseErrors,
} from './verify-live-deployment.mjs';

const expectedSha = 'b'.repeat(40);
const versionId = '11111111-2222-3333-4444-555555555555';

async function immediateWait<T = void>(_delay?: number, value?: T): Promise<T> {
  return value as T;
}

function regionalResult(country: string, city: string, sha = expectedSha) {
  return {
    probe: { country, city },
    result: {
      statusCode: 200,
      headers: { 'cache-control': 'no-store', 'cf-ray': `test-${country}` },
      rawBody: JSON.stringify({ sha, versionId, oauthConfigured: true }),
    },
  };
}

describe('deployment version verification', () => {
  it('accepts only an exact Git commit ID', () => {
    expect(validateExpectedSha(expectedSha)).toBe(expectedSha);
    expect(() => validateExpectedSha('expected-sha')).toThrow('exact lowercase 40-hex');
    expect(() => validateExpectedSha(undefined)).toThrow('exact lowercase 40-hex');
  });

  it('requires the SHA, Worker version, and no-store response policy', () => {
    expect(
      versionResponseErrors({
        statusCode: 200,
        headers: { 'cache-control': 'no-store', 'cf-ray': 'test-FRA' },
        body: { sha: expectedSha, versionId, oauthConfigured: true },
        expectedSha,
      }),
    ).toEqual([]);

    expect(
      versionResponseErrors({
        statusCode: 200,
        headers: {},
        body: { sha: null, versionId: null, oauthConfigured: false },
        expectedSha,
      }),
    ).toEqual([
      `expected SHA ${expectedSha}, received <empty>`,
      'missing Worker version ID',
      'Cloudflare OAuth bindings are incomplete',
      'expected Cache-Control: no-store, received <empty>',
    ]);
  });

  it('requires consecutive successful direct probes', async () => {
    const responses = [
      { sha: null, versionId: null, oauthConfigured: false },
      { sha: expectedSha, versionId, oauthConfigured: true },
      { sha: expectedSha, versionId, oauthConfigured: true },
    ];
    const fetchImplementation = vi.fn(async () =>
      Response.json(responses.shift(), {
        headers: { 'Cache-Control': 'no-store', 'CF-Ray': 'test-FRA' },
      }),
    );

    await expect(
      verifyLocalDeployment({
        expectedSha,
        fetchImplementation,
        stabilizationMs: 0,
        checkIntervalMs: 0,
        consecutiveChecks: 2,
        maxAttempts: 3,
        waitImplementation: immediateWait,
        log: vi.fn(),
      }),
    ).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('validates every regional result', () => {
    expect(
      globalMeasurementErrors(
        {
          status: 'finished',
          results: [
            regionalResult('US', 'Buffalo'),
            regionalResult('DE', 'Falkenstein'),
            regionalResult('JP', 'Tokyo'),
          ],
        },
        expectedSha,
        vi.fn(),
      ),
    ).toEqual([]);
  });

  it('requests one probe for every configured region', () => {
    const request = globalpingRequest(expectedSha);

    expect(request.limit).toBe(request.locations.length);
    expect(request.locations).toEqual([{ country: 'US' }, { country: 'DE' }, { country: 'JP' }]);
  });

  it('retries a fresh measurement while regional rollout converges', async () => {
    const staleSha = 'a'.repeat(40);
    const responses = [
      Response.json({ id: 'measurement-1' }, { status: 201 }),
      Response.json({
        status: 'finished',
        results: [
          regionalResult('US', 'Los Angeles', staleSha),
          regionalResult('DE', 'Falkenstein'),
          regionalResult('JP', 'Tokyo'),
        ],
      }),
      Response.json({ id: 'measurement-2' }, { status: 201 }),
      Response.json({
        status: 'finished',
        results: [
          regionalResult('US', 'Los Angeles'),
          regionalResult('DE', 'Falkenstein'),
          regionalResult('JP', 'Tokyo'),
        ],
      }),
    ];
    const fetchImplementation = vi.fn(async () => responses.shift()!);
    const waitImplementation = vi.fn(immediateWait);
    const log = vi.fn();

    await expect(
      verifyGlobalDeployment({
        expectedSha,
        fetchImplementation,
        waitImplementation,
        measurementAttempts: 2,
        retryIntervalMs: 0,
        pollIntervalMs: 0,
        log,
      }),
    ).resolves.toBeUndefined();

    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(waitImplementation).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Retrying measurement 2/2'));
  });
});
