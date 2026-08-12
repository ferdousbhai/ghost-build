// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentApproval } from './DeploymentApproval.client';

const mocks = vi.hoisted(() => ({
  captureProductEvent: vi.fn(() => Promise.resolve()),
  fetchUserRuntime: vi.fn(),
}));

vi.mock('~/lib/cloudflare/runtime-session', () => ({ fetchUserRuntime: mocks.fetchUserRuntime }));
vi.mock('~/lib/telemetry.client', () => ({ captureProductEvent: mocks.captureProductEvent }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
}));

describe('DeploymentApproval', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.captureProductEvent.mockClear();
    mocks.fetchUserRuntime.mockReset();
    let statusReads = 0;
    mocks.fetchUserRuntime.mockImplementation(async (path: string) => {
      if (path.endsWith('/approve')) {
        return Response.json({ deployment: { status: 'approved' } });
      }
      statusReads += 1;
      return Response.json({ deployment: { status: statusReads === 1 ? 'awaiting_approval' : 'succeeded' } });
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('starts an approved deployment automatically without a consent card', async () => {
    await act(async () => {
      root.render(
        <DeploymentApproval
          deployment={{
            id: 'deployment-1',
            planDigest: 'a'.repeat(64),
            resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
          }}
        />,
      );
    });

    const approvalCall = mocks.fetchUserRuntime.mock.calls.find(([path]) => String(path).endsWith('/approve'));
    expect(approvalCall).toBeDefined();
    expect(JSON.parse(String((approvalCall?.[1] as RequestInit).body))).toEqual({
      planDigest: 'a'.repeat(64),
      confirmCloudflareBilling: true,
      confirmWorkersPaidNotAutomatic: true,
    });
    expect(container.textContent).toContain('Deployed');
    expect(container.textContent).not.toContain('usage charges');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('keeps polling when the execute request times out after the deployment starts', async () => {
    let statusReads = 0;
    mocks.fetchUserRuntime.mockImplementation(async (path: string) => {
      if (path.endsWith('/execute')) {
        throw new Error('Request timed out');
      }
      statusReads += 1;
      return Response.json({
        deployment: {
          status: statusReads === 1 ? 'approved' : statusReads === 2 ? 'deploying' : 'succeeded',
          productionUrl: statusReads >= 3 ? 'https://app.example' : null,
        },
      });
    });

    await act(async () => {
      root.render(
        <DeploymentApproval
          deployment={{
            id: 'deployment-1',
            planDigest: 'a'.repeat(64),
            resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
          }}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_600));
    });

    expect(container.textContent).toContain('Deployed');
    expect(container.querySelector('a')?.href).toBe('https://app.example/');
    expect(container.textContent).not.toContain('Deployment failed');
  });

  it('shows live deployment activity while the execute request is still running', async () => {
    let statusReads = 0;
    mocks.fetchUserRuntime.mockImplementation(async (path: string) => {
      if (path.endsWith('/execute')) {
        return new Promise<Response>(() => undefined);
      }
      statusReads += 1;
      return Response.json({
        deployment: {
          status: statusReads === 1 ? 'approved' : 'deploying',
          activity:
            statusReads < 3
              ? [{ sequence: 10, message: 'Preparing Cloudflare resources', createdAt: 1 }]
              : [
                  { sequence: 10, message: 'Preparing Cloudflare resources', createdAt: 1 },
                  { sequence: 32, message: 'Installing app dependencies', createdAt: 2 },
                ],
        },
      });
    });

    await act(async () => {
      root.render(
        <DeploymentApproval
          deployment={{
            id: 'deployment-1',
            planDigest: 'a'.repeat(64),
            resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
          }}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_600));
    });

    expect(container.textContent).toContain('Deploying…');
    expect(container.textContent).toContain('Preparing Cloudflare resources');
    expect(container.textContent).toContain('Installing app dependencies');
  });

  it('prepares a current-revision plan after a terminal deployment failure', async () => {
    mocks.fetchUserRuntime.mockImplementation(async (path: string) =>
      path.endsWith('/retry')
        ? Response.json({ error: 'Deployment plan is stale.' }, { status: 409 })
        : Response.json({
            deployment: path.includes('deployment-1')
              ? { status: 'failed', error: { message: 'The project changed.' } }
              : { status: 'awaiting_approval' },
          }),
    );
    const onPrepareDeployment = vi.fn(async () => ({
      id: 'deployment-2',
      planDigest: 'b'.repeat(64),
      resources: [{ type: 'worker' as const, logicalName: 'app', proposedName: 'ghostbuild-app-2' }],
    }));
    await act(async () => {
      root.render(
        <DeploymentApproval
          deployment={{
            id: 'deployment-1',
            planDigest: 'a'.repeat(64),
            resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
          }}
          onPrepareDeployment={onPrepareDeployment}
        />,
      );
    });

    const retry = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Try again',
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());

    expect(onPrepareDeployment).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('usage charges');
    expect(mocks.fetchUserRuntime.mock.calls.some(([path]) => String(path).endsWith('/retry'))).toBe(true);
  });

  it('resets the failed row when the current revision keeps the same plan', async () => {
    mocks.fetchUserRuntime.mockImplementation(async (path: string) =>
      path.endsWith('/retry')
        ? Response.json({
            deployment: {
              id: 'deployment-1',
              planDigest: 'a'.repeat(64),
              plan: {
                resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
              },
            },
          })
        : Response.json({ deployment: { status: 'failed', error: { message: 'The project changed.' } } }),
    );
    const onPrepareDeployment = vi.fn(async () => ({
      id: 'deployment-1',
      planDigest: 'a'.repeat(64),
      resources: [{ type: 'worker' as const, logicalName: 'app', proposedName: 'ghostbuild-app' }],
    }));
    await act(async () => {
      root.render(
        <DeploymentApproval
          deployment={{
            id: 'deployment-1',
            planDigest: 'a'.repeat(64),
            resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
          }}
          onPrepareDeployment={onPrepareDeployment}
        />,
      );
    });

    const retry = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Try again',
    );
    await act(async () => retry?.click());

    expect(onPrepareDeployment).not.toHaveBeenCalled();
    expect(mocks.fetchUserRuntime.mock.calls.some(([path]) => String(path).endsWith('/retry'))).toBe(true);
    expect(container.textContent).not.toContain('usage charges');
  });

  it('collapses an internal failed-state conflict to one clear retry action', async () => {
    mocks.fetchUserRuntime.mockResolvedValue(
      Response.json({
        deployment: { status: 'failed', error: { message: 'Deployment cannot continue from status failed.' } },
      }),
    );
    await act(async () => {
      root.render(
        <DeploymentApproval
          deployment={{
            id: 'deployment-1',
            planDigest: 'a'.repeat(64),
            resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
          }}
        />,
      );
    });

    expect(container.textContent).toContain('Deployment failed');
    expect(container.textContent).toContain('Try again');
    expect(container.textContent).not.toContain('Publish this app');
    expect(container.textContent).not.toContain('status failed');
  });

  it('shows only the concise first line of an internal deployment error', async () => {
    mocks.fetchUserRuntime.mockImplementation(async () =>
      Response.json({
        deployment: {
          status: 'failed',
          error: { message: 'Cloudflare build failed.\nInternal stack trace\nSecret implementation detail' },
        },
      }),
    );
    await act(async () => {
      root.render(
        <DeploymentApproval
          deployment={{
            id: 'deployment-1',
            planDigest: 'a'.repeat(64),
            resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
          }}
        />,
      );
    });

    expect(container.textContent).toContain('Cloudflare build failed.');
    expect(container.textContent).not.toContain('Internal stack trace');
    expect(container.textContent).not.toContain('Secret implementation detail');
  });
});
