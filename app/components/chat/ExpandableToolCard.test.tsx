// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpandableToolCard } from './ExpandableToolCard';

describe('ExpandableToolCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('uses one header button to toggle details and keeps consistent dividers', async () => {
    const onToggle = vi.fn();
    await act(async () =>
      root.render(
        <ExpandableToolCard
          expanded
          leading={<span>Leading</span>}
          header={<span>Header</span>}
          body={<span>Body</span>}
          onToggle={onToggle}
        />,
      ),
    );

    const shell = container.querySelector('.tool-call-card');
    const button = container.querySelector('button');
    const dividers = container.querySelectorAll('.border-r, .border-l');
    const body = container.querySelector('.tool-details');

    expect(shell?.classList).toContain('border-bolt-elements-artifacts-borderColor');
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(dividers).toHaveLength(2);
    expect(
      [...dividers].every((divider) => divider.classList.contains('border-bolt-elements-artifacts-borderColor')),
    ).toBe(true);
    expect(body?.classList).toContain('border-t');
    expect(body?.classList).toContain('border-bolt-elements-artifacts-borderColor');

    await act(async () => button?.click());
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
