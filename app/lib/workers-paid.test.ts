import { describe, expect, test } from 'vitest';
import { isWorkersAiFreeAllocationError, workersPaidRequiredMessage } from './workers-paid';

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
});
