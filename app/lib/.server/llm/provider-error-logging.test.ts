import { describe, expect, it, vi } from 'vitest';
import { logProviderFailure } from './provider-error-logging';

describe('logProviderFailure', () => {
  it('drops provider request bodies and error messages at the logging boundary', () => {
    const logger = { error: vi.fn() };
    const providerError = Object.assign(new Error('provider included private request values'), {
      requestBodyValues: { prompt: 'SECRET_PROVIDER_PROMPT' },
    });

    logProviderFailure(logger, 'Workers AI request failed.', providerError);

    expect(logger.error).toHaveBeenCalledWith('Workers AI request failed.');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SECRET_PROVIDER_PROMPT');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private request values');
  });
});
