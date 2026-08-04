// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STARTER_PROMPTS, StarterPrompts } from './HomeIntro.client';

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

describe('StarterPrompts', () => {
  it('offers concrete, keyboard-native prompts and returns the complete selected prompt', async () => {
    const onSelect = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<StarterPrompts disabled={false} onSelect={onSelect} />));

    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons).toHaveLength(STARTER_PROMPTS.length);
    expect(buttons.every((button) => button.type === 'button')).toBe(true);

    act(() => buttons[0]?.click());
    expect(onSelect).toHaveBeenCalledWith(STARTER_PROMPTS[0].prompt);
  });

  it('blocks prompt selection while the current turn is starting', async () => {
    const onSelect = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<StarterPrompts disabled onSelect={onSelect} />));

    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    act(() => buttons[0]?.click());
    expect(onSelect).not.toHaveBeenCalled();
  });
});
