// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ExpandableToolCard } from './ExpandableToolCard';

describe('ExpandableToolCard', () => {
  it('uses one consistent border treatment for its shell and dividers', () => {
    document.body.innerHTML = renderToStaticMarkup(
      <ExpandableToolCard
        expanded
        leading={<span>Leading</span>}
        header={<span>Header</span>}
        body={<span>Body</span>}
        onOpen={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    const shell = document.querySelector('.tool-call-card');
    const buttons = document.querySelectorAll('button');
    const leading = document.querySelector('.border-r');
    const body = document.querySelector('.tool-details');

    expect(shell?.classList).toContain('border-bolt-elements-artifacts-borderColor');
    expect(leading?.classList).toContain('border-bolt-elements-artifacts-borderColor');
    expect(buttons[1]?.classList).toContain('border-l');
    expect(buttons[1]?.classList).toContain('border-bolt-elements-artifacts-borderColor');
    expect(body?.classList).toContain('border-t');
    expect(body?.classList).toContain('border-bolt-elements-artifacts-borderColor');
  });
});
