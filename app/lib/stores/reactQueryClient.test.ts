import { describe, expect, it } from 'vitest';
import { DataOperationError, UserRuntimeRequestError } from '~/lib/cloudflare/client';
import { queryClient } from './reactQueryClient';

describe('query retry policy', () => {
  const retry = queryClient.getDefaultOptions().queries?.retry;

  it('retries transient failures but not permanent data-operation failures', () => {
    expect(typeof retry).toBe('function');
    const shouldRetry = retry as (failureCount: number, error: Error) => boolean;

    expect(shouldRetry(0, new DataOperationError('busy', 503, true))).toBe(true);
    expect(shouldRetry(0, new UserRuntimeRequestError('overloaded', 503, false))).toBe(false);
    expect(shouldRetry(0, new DataOperationError('invalid', 400, false))).toBe(false);
    expect(shouldRetry(0, Object.assign(new Error('canceled'), { name: 'AbortError' }))).toBe(false);
    expect(shouldRetry(2, new Error('network'))).toBe(false);
  });
});
