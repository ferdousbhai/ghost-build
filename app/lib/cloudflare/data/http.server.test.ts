import { describe, expect, it, vi } from 'vitest';
import { internalErrorResponse } from './http.server';
import { SubchatLimitError } from './errors';
import { ChatBackupQuotaError } from './chat-backup-quota.server';

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

  it('returns typed quota responses without exposing internal accounting state', async () => {
    const rate = internalErrorResponse(new ChatBackupQuotaError('request-rate', 60), 'Unknown data error');
    const storage = internalErrorResponse(new ChatBackupQuotaError('storage'), 'Unknown data error');
    const notReady = internalErrorResponse(new ChatBackupQuotaError('not-ready', 900), 'Unknown data error');

    expect(rate.status).toBe(429);
    expect(rate.headers.get('Retry-After')).toBe('60');
    expect(storage.status).toBe(409);
    expect(notReady.status).toBe(503);
    expect(notReady.headers.get('Retry-After')).toBe('900');
  });
});
