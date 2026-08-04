import { describe, expect, test } from 'vitest';
import {
  CLOUDFLARE_AI_FUNDING_REQUIRED_MARKER,
  cloudflareAiFundingRequiredMessage,
  isCloudflareAiFundingError,
  isWorkersAiFreeAllocationError,
  workersPaidRequiredMessage,
} from './workers-paid';

describe('Workers Paid consent boundary', () => {
  test('recognizes free Workers AI allocation exhaustion without treating generic failures as billing prompts', () => {
    expect(isWorkersAiFreeAllocationError(new Error('Free AI allocation of 10,000 neurons exhausted'))).toBe(true);
    expect(isWorkersAiFreeAllocationError({ responseBody: 'Upgrade to Workers Paid to continue' })).toBe(true);
    expect(isWorkersAiFreeAllocationError(new Error('capacity temporarily exceeded'))).toBe(false);
    expect(isWorkersAiFreeAllocationError(new Error('permission denied'))).toBe(false);
  });

  test('states that Ghostbuild did not authorize the paid plan', () => {
    expect(workersPaidRequiredMessage()).toContain('explicitly authorize Workers Paid');
    expect(workersPaidRequiredMessage()).toContain('Ghostbuild did not upgrade your plan');
  });

  test('recognizes partner-model funding failures without conflating them with Workers Paid', () => {
    const error = {
      responseBody: JSON.stringify({
        errors: [{ code: 2021, message: 'Insufficient balance; add money to your gateway or use BYOK' }],
      }),
    };

    expect(isCloudflareAiFundingError(error)).toBe(true);
    expect(isWorkersAiFreeAllocationError(error)).toBe(false);
    expect(cloudflareAiFundingRequiredMessage()).toContain(CLOUDFLARE_AI_FUNDING_REQUIRED_MARKER);
    expect(cloudflareAiFundingRequiredMessage()).toContain('Ghostbuild did not make a purchase');
  });

  test('does not treat unrelated provider failures as AI Gateway funding failures', () => {
    expect(isCloudflareAiFundingError(new Error('Provider timed out'))).toBe(false);
  });
});
