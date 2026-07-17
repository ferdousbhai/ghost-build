import { describe, expect, it, vi } from 'vitest';
import { globalMeasurementErrors, verifyLocalDeployment, versionResponseErrors } from './verify-live-deployment.mjs';

const expectedSha = 'expected-sha';
const versionId = '11111111-2222-3333-4444-555555555555';

describe('deployment version verification', () => {
  it('requires the SHA, Worker version, and no-store response policy', () => {
    expect(
      versionResponseErrors({
        statusCode: 200,
        headers: { 'cache-control': 'no-store', 'cf-ray': 'test-FRA' },
        body: { sha: expectedSha, versionId },
        expectedSha,
      }),
    ).toEqual([]);

    expect(
      versionResponseErrors({
        statusCode: 200,
        headers: {},
        body: { sha: null, versionId: null },
        expectedSha,
      }),
    ).toEqual([
      'expected SHA expected-sha, received <empty>',
      'missing Worker version ID',
      'expected Cache-Control: no-store, received <empty>',
    ]);
  });

  it('requires consecutive successful direct probes', async () => {
    const responses = [
      { sha: null, versionId: null },
      { sha: expectedSha, versionId },
      { sha: expectedSha, versionId },
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
        waitImplementation: vi.fn(async () => undefined),
        log: vi.fn(),
      }),
    ).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('validates every regional result', () => {
    const result = (country: string, city: string) => ({
      probe: { country, city },
      result: {
        statusCode: 200,
        headers: { 'cache-control': 'no-store', 'cf-ray': `test-${country}` },
        rawBody: JSON.stringify({ sha: expectedSha, versionId }),
      },
    });
    expect(
      globalMeasurementErrors(
        { status: 'finished', results: [result('US', 'Buffalo'), result('DE', 'Falkenstein'), result('JP', 'Tokyo')] },
        expectedSha,
      ),
    ).toEqual([]);
  });
});
