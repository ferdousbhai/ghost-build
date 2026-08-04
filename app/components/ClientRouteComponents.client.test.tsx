// @vitest-environment jsdom

import { act, lazy, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientComponent } from './ClientRouteComponents';

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

describe('stable client route components', () => {
  it('loads a lazy identity once and preserves child state across wrapper rerenders', async () => {
    function StatefulChild({ label }: { label: string }) {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount((value) => value + 1)}>{`${label}:${count}`}</button>;
    }

    const load = vi.fn(async () => ({ default: StatefulChild }));
    const StableLazyChild = lazy(load);
    const getStableLazyChild = vi.fn(() => StableLazyChild);
    const ClientChild = createClientComponent(getStableLazyChild, () => <p>Loading child…</p>);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<ClientChild label="first" />));
    await vi.waitFor(() => expect(container.querySelector('button')?.textContent).toBe('first:0'));
    await act(async () => container.querySelector('button')?.click());
    expect(container.querySelector('button')?.textContent).toBe('first:1');

    await act(async () => root?.render(<ClientChild label="second" />));

    expect(container.querySelector('button')?.textContent).toBe('second:1');
    expect(load).toHaveBeenCalledTimes(1);
    expect(new Set(getStableLazyChild.mock.results.map(({ value }) => value))).toEqual(new Set([StableLazyChild]));
  });
});
