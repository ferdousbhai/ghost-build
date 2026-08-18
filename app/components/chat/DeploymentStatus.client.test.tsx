// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DeploymentStatus } from './DeploymentStatus.client';

vi.mock('~/lib/telemetry.client', () => ({ captureProductEvent: vi.fn() }));

describe('DeploymentStatus', () => {
  it('renders deployment progress without an approval protocol', () => {
    const html = renderToStaticMarkup(<DeploymentStatus deployment={{ status: 'deploying' }} />);
    expect(html).toContain('Deploying');
    expect(html).not.toContain('approve');
    expect(html).not.toContain('billing');
  });

  it('links a successful production deployment and names its revision', () => {
    const html = renderToStaticMarkup(
      <DeploymentStatus
        deployment={{ status: 'succeeded', workspaceRevision: 12, productionUrl: 'https://app.example.com' }}
      />,
    );
    expect(html).toContain('Deployed');
    expect(html).toContain('https://app.example.com');
    expect(html).toContain('data-workspace-revision="12"');
  });

  it('offers one retry action after failure', () => {
    const html = renderToStaticMarkup(
      <DeploymentStatus deployment={{ status: 'failed', error: 'Build failed.' }} onRetry={vi.fn()} />,
    );
    expect(html).toContain('Deployment failed');
    expect(html).toContain('Build failed.');
    expect(html).toContain('Try again');
  });
});
