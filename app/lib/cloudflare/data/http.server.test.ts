import { describe, expect, it, vi } from 'vitest';
import { internalErrorResponse } from './http.server';
import { SubchatLimitError } from './errors';

describe('internalErrorResponse', () => {
  it('does not reflect unexpected backend error messages to callers', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = internalErrorResponse(
      new Error('SECRET_DATABASE_MARKER: no such table cloudflare_credentials'),
      'Unknown data error',
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Unknown data error' });
    consoleError.mockRestore();
  });

  it('returns a conflict when a project reaches the subchat ceiling', async () => {
    const response = internalErrorResponse(new SubchatLimitError(), 'Unknown data error');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'This project has reached the maximum number of subchats.' });
  });

  it('marks Durable Object overloads as non-retryable without exposing provider details', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const overloaded = Object.assign(new Error('SECRET_PROVIDER_MARKER: queue full'), {
      overloaded: true,
      retryable: true,
    });

    const response = internalErrorResponse(overloaded, 'Unknown data error');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Unknown data error', retryable: false });
    consoleError.mockRestore();
  });
});
