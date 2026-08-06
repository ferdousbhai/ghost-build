import { describe, expect, it } from 'vitest';
import { PREVIEW_SANDBOX, previewDisplayStatus, previewFrameUrl } from './Preview';

describe('previewDisplayStatus', () => {
  const expired = { expiresAt: '2026-08-05T00:00:00.000Z' };
  const now = Date.parse('2026-08-05T00:01:00.000Z');

  it('expires a completed preview', () => {
    expect(previewDisplayStatus('ready', expired, now)).toBe('expired');
  });

  it('does not hide a new build failure behind an expired preview', () => {
    expect(previewDisplayStatus('failed', expired, now)).toBe('failed');
  });

  it.each(['queued', 'building'])('keeps %s visible while replacing an unusable preview', (status) => {
    expect(previewDisplayStatus(status, expired, now - 120_000, false)).toBe(status);
  });

  it('fails an unusable preview when no replacement is running', () => {
    expect(previewDisplayStatus('ready', expired, now - 120_000, false)).toBe('failed');
  });

  it('preserves an expired preview after reconnect', () => {
    expect(previewDisplayStatus('expired', expired, now, false)).toBe('expired');
  });

  it('expires the prior preview after its replacement is cancelled', () => {
    expect(previewDisplayStatus('cancelled', expired, now, true)).toBe('expired');
  });
});

describe('previewFrameUrl', () => {
  it('keeps Cloudflare Quick Tunnels on their real origin so generated apps can hydrate and persist state', () => {
    expect(previewFrameUrl('https://random-words.trycloudflare.com')).toBe('https://random-words.trycloudflare.com/');
    expect(PREVIEW_SANDBOX.split(' ')).toEqual(expect.arrayContaining(['allow-same-origin', 'allow-scripts']));
  });

  it.each([
    'https://trycloudflare.com',
    'https://trycloudflare.com.example.com',
    'https://ghostbuild.dev',
    'http://random-words.trycloudflare.com',
    'https://user:password@random-words.trycloudflare.com',
    'https://random-words.trycloudflare.com:8443',
    '/relative-preview',
    'not a url',
  ])('rejects an untrusted preview URL: %s', (url) => {
    expect(previewFrameUrl(url)).toBeNull();
  });
});
