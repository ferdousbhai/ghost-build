// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/components/ClientRouteComponents', () => ({
  ClientHeader: () => null,
  ClientHomepage: ({ initialId }: { initialId: string }) => <output data-testid="project-id">{initialId}</output>,
}));
vi.mock('~/components/trust/TrustLinks', () => ({ TrustFooter: () => null }));

import { IndexShell } from './index';

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

describe('homepage project identity', () => {
  it('keeps the live project ID when route masking revalidates the root loader', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<IndexShell initialId="project-a" />));
    await act(async () => root?.render(<IndexShell initialId="project-b" />));

    expect(container.querySelector('[data-testid="project-id"]')?.textContent).toBe('project-a');
  });
});
