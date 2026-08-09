import { describe, expect, it, vi } from 'vitest';
import { logProviderFailure } from './provider-error-logging';

describe('logProviderFailure', () => {
  it('logs the error kind without its message, stack, or request payload', () => {
    const logger = { error: vi.fn() };
    const error = new TypeError(`bad schema\n${'x'.repeat(1_000)}`);

    logProviderFailure(logger, 'provider failed', error);

    expect(logger.error).toHaveBeenCalledWith('provider failed', { kind: 'TypeError' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('bad schema');
  });

  it('includes only validated static diagnostic codes', () => {
    const logger = { error: vi.fn() };
    const error = Object.assign(new Error('private'), { diagnosticCode: 'pi_prepare:model_input' });

    logProviderFailure(logger, 'provider failed', error);

    expect(logger.error).toHaveBeenCalledWith('provider failed', {
      kind: 'Error',
      diagnosticCode: 'pi_prepare:model_input',
    });
  });

  it('logs response status without reading its body', () => {
    const logger = { error: vi.fn() };

    logProviderFailure(logger, 'provider failed', new Response('private body', { status: 429, statusText: 'Limited' }));

    expect(logger.error).toHaveBeenCalledWith('provider failed', {
      kind: 'Response',
      status: 429,
      statusText: 'Limited',
    });
  });
});
