// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeploymentSecurityPanel, type DeploymentSecurityStatus } from './CloudflareCard.client';

describe('DeploymentSecurityPanel', () => {
  it('requires a fresh, explicitly approved Builder deployment and never promises automatic mutation', () => {
    const status: DeploymentSecurityStatus = {
      state: 'action_required',
      hasMore: false,
      nextCursor: null,
      items: [
        {
          scope: 'managed',
          state: 'upgrade_available',
          deploymentId: 'deployment-1',
          productionUrl: 'https://app.example.com/',
          checkedAt: 1_700_000_000_000,
          workerName: 'ghostbuild-deployment-1',
          remediation: { kind: 'replace_from_fresh_builder', builderPath: '/', manualCleanupRequired: true },
        },
      ],
    };

    document.body.innerHTML = renderToStaticMarkup(<DeploymentSecurityPanel status={status} />);

    expect(document.body.textContent).toContain('never overwrite an existing deployment automatically');
    expect(document.body.textContent).toContain('retire the affected Worker');
    expect(document.body.textContent).toContain('ghostbuild-deployment-1');
    expect(document.querySelector('a[href="/"]')?.textContent).toContain('Start secure replacement');
    expect(document.querySelector('a[href="https://dash.cloudflare.com/"]')?.textContent).toContain(
      'Cloudflare dashboard',
    );
    expect(document.querySelector('a[href="https://app.example.com/"]')).not.toBeNull();
  });

  it('directs failed verification to Cloudflare reauthorization', () => {
    const status: DeploymentSecurityStatus = {
      state: 'action_required',
      hasMore: false,
      nextCursor: null,
      items: [
        {
          scope: 'historical',
          state: 'verification_failed',
          deploymentId: null,
          productionUrl: null,
          checkedAt: null,
          workerName: 'ghostbuild-cloudflare-app',
          remediation: { kind: 'reauthorize_cloudflare' },
        },
      ],
    };

    document.body.innerHTML = renderToStaticMarkup(<DeploymentSecurityPanel status={status} />);

    expect(document.body.textContent).toContain('could not verify');
    expect(document.querySelector('button')?.textContent).toContain('Reauthorize Cloudflare');
  });

  it('offers bounded continuation when more owner-scoped inventory rows exist', () => {
    const status: DeploymentSecurityStatus = {
      state: 'action_required',
      hasMore: true,
      nextCursor: 'ghostbuild-cloudflare-app',
      items: [
        {
          scope: 'historical',
          state: 'user_action_required',
          deploymentId: null,
          productionUrl: null,
          checkedAt: 1_700_000_000_000,
          workerName: 'ghostbuild-cloudflare-app',
          remediation: { kind: 'replace_from_fresh_builder', builderPath: '/', manualCleanupRequired: true },
        },
      ],
    };

    document.body.innerHTML = renderToStaticMarkup(<DeploymentSecurityPanel status={status} />);

    expect(document.body.textContent).toContain('ghostbuild-cloudflare-app');
    expect(document.querySelector('button')?.textContent).toContain('Load more deployment checks');
  });

  it('keeps a full current page partial and visible while more inventory remains', () => {
    const status: DeploymentSecurityStatus = {
      state: 'checking',
      hasMore: true,
      nextCursor: 'ghostbuild-025',
      items: Array.from({ length: 25 }, (_, index) => ({
        scope: 'managed' as const,
        state: 'current' as const,
        deploymentId: `deployment-${index + 1}`,
        productionUrl: `https://app-${index + 1}.example.com/`,
        checkedAt: 1_700_000_000_000,
        workerName: `ghostbuild-${String(index + 1).padStart(3, '0')}`,
        remediation: null,
      })),
    };

    document.body.innerHTML = renderToStaticMarkup(<DeploymentSecurityPanel status={status} />);

    expect(document.body.textContent).toContain('Checking generated app security');
    expect(document.body.textContent).toContain('25 generated apps are verified current on this page');
    expect(document.body.textContent).not.toContain('Generated app security is current');
    expect(document.querySelector('button')?.textContent).toContain('Load more deployment checks');
  });
});
