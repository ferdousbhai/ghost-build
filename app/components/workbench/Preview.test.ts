import { describe, expect, it } from 'vitest';
import { idleBuilderPreviewState } from '~/agents/builder-preview-types';
import { previewDisplayStatus, previewPresentation } from '~/lib/common/preview-presentation';
import { previewQuickTunnelUrl } from '~/lib/common/preview-url';
import { PREVIEW_SANDBOX } from './Preview';

describe('previewDisplayStatus', () => {
  const expired = { expiresAt: '2026-08-05T00:00:00.000Z' };
  const now = Date.parse('2026-08-05T00:01:00.000Z');

  it('expires a completed preview', () => {
    expect(previewDisplayStatus('ready', expired, now)).toBe('expired');
  });

  it('does not hide a new build failure behind an expired preview', () => {
    expect(previewDisplayStatus('failed', expired, now)).toBe('failed');
  });

  it.each(['queued', 'building'] as const)('keeps %s visible while replacing an unusable preview', (status) => {
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
    expect(previewQuickTunnelUrl('https://random-words.trycloudflare.com')).toBe(
      'https://random-words.trycloudflare.com/',
    );
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
    expect(previewQuickTunnelUrl(url)).toBeNull();
  });
});

describe('previewPresentation', () => {
  const now = Date.parse('2026-08-06T20:00:00.000Z');
  const success = {
    mode: 'production' as const,
    id: 'preview-1',
    url: 'https://random-words.trycloudflare.com',
    workspaceRevision: 1,
    snapshotRevision: 'snapshot-1',
    readyAt: '2026-08-06T19:00:00.000Z',
    expiresAt: '2026-08-06T21:00:00.000Z',
  };

  it('offers Update for a stale live preview', () => {
    const presentation = previewPresentation(
      { ...idleBuilderPreviewState(2), status: 'ready', stale: true, active: success, lastSuccessful: success },
      now,
    );

    expect(presentation.canUpdate).toBe(true);
    expect(presentation.canReload).toBe(true);
  });

  it('shows updating feedback while retaining the previous iframe', () => {
    const presentation = previewPresentation(
      { ...idleBuilderPreviewState(2), status: 'building', stale: true, lastSuccessful: success },
      now,
    );

    expect(presentation.isUpdatingVisible).toBe(true);
    expect(presentation.canUpdate).toBe(false);
  });

  it('offers Update after a stale replacement is cancelled', () => {
    const presentation = previewPresentation(
      { ...idleBuilderPreviewState(2), status: 'cancelled', stale: true, lastSuccessful: success },
      now,
    );

    expect(presentation.canUpdate).toBe(true);
    expect(presentation.canReload).toBe(true);
  });

  it('reports which guarantee the visible preview carries', () => {
    const live = {
      mode: 'dev' as const,
      id: 'preview-dev',
      url: 'https://random-words.trycloudflare.com',
      startedFromWorkspaceRevision: 1,
      readyAt: '2026-08-06T19:00:00.000Z',
      expiresAt: '2026-08-06T21:00:00.000Z',
    };

    expect(
      previewPresentation({ ...idleBuilderPreviewState(2), status: 'ready', mode: 'dev', active: live }, now).mode,
    ).toBe('dev');
    expect(previewPresentation({ ...idleBuilderPreviewState(2), status: 'ready', active: success }, now).mode).toBe(
      'production',
    );
    // Before anything is visible, the mode being built is what the frame should describe.
    expect(previewPresentation({ ...idleBuilderPreviewState(2), status: 'building', mode: 'dev' }, now).mode).toBe(
      'dev',
    );
  });

  it('never offers Update for a live dev preview, which already carries the change', () => {
    const live = {
      mode: 'dev' as const,
      id: 'preview-dev',
      url: 'https://random-words.trycloudflare.com',
      startedFromWorkspaceRevision: 1,
      readyAt: '2026-08-06T19:00:00.000Z',
      expiresAt: '2026-08-06T21:00:00.000Z',
    };
    const presentation = previewPresentation(
      { ...idleBuilderPreviewState(9), status: 'ready', mode: 'dev', active: live, lastSuccessful: live },
      now,
    );

    expect(presentation.canUpdate).toBe(false);
    expect(presentation.canReload).toBe(true);
  });

  it.each([
    ['expired', { ...success, expiresAt: '2026-08-06T19:59:59.000Z' }],
    ['invalid', { ...success, url: 'https://example.com' }],
  ])('disables reload for an %s preview', (_label, candidate) => {
    const presentation = previewPresentation(
      { ...idleBuilderPreviewState(1), status: 'ready', active: candidate, lastSuccessful: candidate },
      now,
    );

    expect(presentation.canReload).toBe(false);
    expect(presentation.previewUrl).toBeNull();
  });
});
