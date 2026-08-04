// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileMap } from 'ghostbuild-agent/types';
import { FileBreadcrumb } from './FileBreadcrumb';

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('FileBreadcrumb', () => {
  it('lets Radix synchronize keyboard open and Escape close state', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const files = {
      '/home/project/src/index.ts': { type: 'file', content: 'export {};' },
    } as FileMap;
    await act(async () => {
      root?.render(<FileBreadcrumb files={files} pathSegments={['', 'home', 'project', 'src', 'index.ts']} />);
    });

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Browse src"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');

    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    await act(async () => {
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });
});
