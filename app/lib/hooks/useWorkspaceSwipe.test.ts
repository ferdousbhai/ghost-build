// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { chatStore } from '~/lib/stores/chatId';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { resolveWorkspaceSwipe, useWorkspaceSwipe } from './useWorkspaceSwipe';

vi.mock('~/lib/stores/workbench.client', async () => {
  const { atom } = await import('nanostores');
  return {
    workbenchStore: {
      showWorkbench: atom(false),
      currentView: atom<'code' | 'preview'>('code'),
    },
  };
});

describe('resolveWorkspaceSwipe', () => {
  it('moves left through Chat, Code, and Preview', () => {
    expect(resolveWorkspaceSwipe({ surface: 'chat', deltaX: -80, deltaY: 5, elapsedMs: 300 })).toBe('code');
    expect(resolveWorkspaceSwipe({ surface: 'code', deltaX: -80, deltaY: 5, elapsedMs: 300 })).toBe('preview');
    expect(resolveWorkspaceSwipe({ surface: 'preview', deltaX: -80, deltaY: 5, elapsedMs: 300 })).toBeNull();
  });

  it('moves right through Preview, Code, and Chat', () => {
    expect(resolveWorkspaceSwipe({ surface: 'preview', deltaX: 80, deltaY: 5, elapsedMs: 300 })).toBe('code');
    expect(resolveWorkspaceSwipe({ surface: 'code', deltaX: 80, deltaY: 5, elapsedMs: 300 })).toBe('chat');
    expect(resolveWorkspaceSwipe({ surface: 'chat', deltaX: 80, deltaY: 5, elapsedMs: 300 })).toBeNull();
  });

  it('ignores short or primarily vertical gestures while accepting a fast flick', () => {
    expect(resolveWorkspaceSwipe({ surface: 'code', deltaX: 30, deltaY: 2, elapsedMs: 300 })).toBeNull();
    expect(resolveWorkspaceSwipe({ surface: 'code', deltaX: 80, deltaY: 70, elapsedMs: 300 })).toBeNull();
    expect(resolveWorkspaceSwipe({ surface: 'code', deltaX: -36, deltaY: 2, elapsedMs: 50 })).toBe('preview');
  });
});

describe('useWorkspaceSwipe', () => {
  it('navigates with touch pointer events while ignoring pen input', async () => {
    chatStore.set({ started: true, aborted: false, showChat: true });
    workbenchStore.showWorkbench.set(false);
    workbenchStore.currentView.set('code');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(createElement(SwipeSurface)));
    const surface = container.firstElementChild as HTMLElement;

    await act(async () => swipe(surface, 'pen'));
    expect(workbenchStore.showWorkbench.get()).toBe(false);

    await act(async () => swipe(surface, 'touch'));
    expect(workbenchStore.showWorkbench.get()).toBe(true);
    expect(workbenchStore.currentView.get()).toBe('code');

    await act(async () => root.unmount());
    container.remove();
  });
});

function SwipeSurface() {
  return createElement('div', useWorkspaceSwipe(true));
}

function swipe(surface: HTMLElement, pointerType: 'pen' | 'touch') {
  surface.dispatchEvent(pointerEvent('pointerdown', 100, pointerType));
  surface.dispatchEvent(pointerEvent('pointerup', 20, pointerType));
}

function pointerEvent(type: 'pointerdown' | 'pointerup', clientX: number, pointerType: 'pen' | 'touch'): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY: 10 });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 1 },
    pointerType: { value: pointerType },
  });
  return event;
}
