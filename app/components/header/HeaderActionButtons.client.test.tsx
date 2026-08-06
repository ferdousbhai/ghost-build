// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatStore } from '~/lib/stores/chatId';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { HeaderActionButtons } from './HeaderActionButtons.client';

vi.mock('~/lib/hooks/useViewport', () => ({ default: () => true }));
vi.mock('~/lib/stores/workbench.client', async () => {
  const { atom } = await import('nanostores');
  return {
    workbenchStore: {
      showWorkbench: atom(false),
      currentView: atom<'code' | 'preview'>('code'),
    },
  };
});

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  chatStore.set({ started: true, aborted: false, showChat: true });
  workbenchStore.showWorkbench.set(false);
  workbenchStore.currentView.set('code');
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

describe('small-screen workspace switcher', () => {
  it('keeps Chat, Code, and Preview directly reachable', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<HeaderActionButtons />));

    const chatButton = getButton(container, 'Chat');
    const codeButton = getButton(container, 'Code');
    const previewButton = getButton(container, 'Preview');

    expect(chatButton.disabled).toBe(false);
    expect(chatButton.getAttribute('aria-pressed')).toBe('true');
    expect(chatButton.className).toContain('focus-visible:ring-inset');

    await act(async () => codeButton.click());
    expect(workbenchStore.showWorkbench.get()).toBe(true);
    expect(workbenchStore.currentView.get()).toBe('code');
    expect(codeButton.getAttribute('aria-pressed')).toBe('true');

    await act(async () => previewButton.click());
    expect(workbenchStore.currentView.get()).toBe('preview');
    expect(previewButton.getAttribute('aria-pressed')).toBe('true');

    await act(async () => chatButton.click());
    expect(chatStore.get().showChat).toBe(true);
    expect(workbenchStore.showWorkbench.get()).toBe(false);
    expect(chatButton.getAttribute('aria-pressed')).toBe('true');
  });

  it('restores Chat when a desktop-only hidden state reaches a small screen', async () => {
    chatStore.setKey('showChat', false);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<HeaderActionButtons />));

    expect(chatStore.get().showChat).toBe(true);
    expect(getButton(container, 'Chat').getAttribute('aria-pressed')).toBe('true');
  });
});

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) {
    throw new Error(`Missing ${label} button`);
  }
  return button;
}
