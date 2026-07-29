// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Modal } from './Modal';

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

describe('Modal', () => {
  it('centers without relying on Tailwind transform variables', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <Modal title="Test dialog" onClose={() => undefined}>
          Dialog content
        </Modal>,
      );
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');

    expect(dialog).not.toBeNull();
    expect(dialog?.className).toContain('inset-4');
    expect(dialog?.className).toContain('m-auto');
    expect(dialog?.className).toContain('box-border');
    expect(dialog?.className).toContain('h-fit');
    expect(dialog?.className).toContain('max-h-[calc(100dvh-2rem)]');
    expect(dialog?.className).not.toContain('translate');
  });
});
