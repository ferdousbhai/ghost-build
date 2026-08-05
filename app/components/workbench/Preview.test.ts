import { describe, expect, it } from 'vitest';
import { previewDisplayStatus } from './Preview';

describe('previewDisplayStatus', () => {
  const expired = { expiresAt: '2026-08-05T00:00:00.000Z' };
  const now = Date.parse('2026-08-05T00:01:00.000Z');

  it('expires a completed preview', () => {
    expect(previewDisplayStatus('ready', expired, now)).toBe('expired');
  });

  it('does not hide a new build failure behind an expired preview', () => {
    expect(previewDisplayStatus('failed', expired, now)).toBe('failed');
  });
});
