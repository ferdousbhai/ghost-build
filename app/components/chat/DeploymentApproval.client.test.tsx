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

  it('records both disclosures from one clear Deploy action', async () => {
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

    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Deploy',
    );
    expect(button).toBeDefined();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);

    await act(async () => button?.click());

    const approvalCall = mocks.fetchUserRuntime.mock.calls.find(([path]) => String(path).endsWith('/approve'));
    expect(approvalCall).toBeDefined();
    expect(JSON.parse(String((approvalCall?.[1] as RequestInit).body))).toEqual({
      planDigest: 'a'.repeat(64),
      confirmCloudflareBilling: true,
      confirmWorkersPaidNotAutomatic: true,
    });
  });
});
