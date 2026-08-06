// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu } from '@ui/Menu';
import { MobileProjectMenuItems } from './DownloadButton';

const downloadZip = vi.hoisted(() => vi.fn());

vi.mock('~/lib/stores/workbench.client', () => ({ workbenchStore: { downloadZip } }));

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
  downloadZip.mockClear();
});

describe('mobile project menu', () => {
  it('keeps secondary project actions reachable off the narrow navbar', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () =>
      root?.render(
        <Menu buttonProps={{ title: 'User menu' }}>
          <MobileProjectMenuItems />
        </Menu>,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="User menu"]');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });

    const menuItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(menuItems.map((item) => item.textContent)).toEqual(['Download code', 'Use dark theme']);
  });
});
