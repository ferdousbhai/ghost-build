// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubchatBar } from './SubchatBar';

const fileSavingState = vi.hoisted(() => ({ value: false }));
let root: Root | undefined;

vi.mock('~/lib/stores/fileUpdateCounter', () => ({
  useAreFilesSaving: () => fileSavingState.value,
}));

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  fileSavingState.value = false;
  document.body.replaceChildren();
});

describe('SubchatBar', () => {
  it('does not present a useless history picker or navigation for a single chat', () => {
    const markup = renderSubchatBar({
      subchats: [subchat(0, 'Build a polished Pocket Poll app')],
      currentSubchatIndex: 0,
    });

    expect(markup).not.toContain('Current chat');
    expect(markup).toContain('Build a polished Pocket Poll app');
    expect(markup).toContain('aria-label="Rename current chat: Build a polished Pocket Poll app"');
    expect(markup).toContain('aria-label="Start a new chat"');
    expect(markup).not.toContain('aria-label="Previous chat"');
    expect(markup).not.toContain('aria-label="Next chat"');
    expect(markup).not.toContain('aria-label="Switch chat.');
  });

  it('exposes chronological navigation and a labeled picker when history exists', () => {
    const markup = renderSubchatBar({
      subchats: [subchat(0, 'Initial build'), subchat(1, 'Add live voting')],
      currentSubchatIndex: 1,
    });

    expect(markup).toContain('aria-label="Previous chat"');
    expect(markup).toContain('aria-label="Next chat"');
    expect(markup).toContain('aria-label="Switch chat. Chat 2 of 2: Add live voting"');
    expect(markup).toContain('aria-label="Rename current chat: Add live voting"');
    expect(markup).toContain('Chat 2 of 2');
  });

  it('blocks history and project-changing actions while files are saving', () => {
    fileSavingState.value = true;
    document.body.innerHTML = renderSubchatBar({
      subchats: [subchat(0, 'Initial build'), subchat(1, 'Add live voting')],
      currentSubchatIndex: 0,
    });

    expect(document.querySelector<HTMLButtonElement>('button[aria-label^="Switch chat."]')?.disabled).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label="Rewind project to this chat"]')?.disabled,
    ).toBe(true);
  });

  it('keeps the confirmation open and prevents repeat submission when creation fails', async () => {
    let finishCreation: ((created: boolean) => void) | undefined;
    const handleCreateSubchat = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishCreation = resolve;
        }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <SubchatBar
          subchats={[subchat(0, 'Initial build')]}
          currentSubchatIndex={0}
          isStreaming={false}
          chatDisabled={false}
          sessionId="session"
          handleCreateSubchat={handleCreateSubchat}
          handleRenameSubchat={() => Promise.resolve(true)}
          isSubchatLoaded
        />,
      );
    });

    const openButton = document.querySelector<HTMLButtonElement>('button[aria-label="Start a new chat"]');
    expect(openButton).not.toBeNull();
    act(() => openButton?.click());

    const createButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Create Chat'),
    );
    const cancelButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Cancel',
    );
    expect(createButton).toBeDefined();
    act(() => createButton?.click());

    expect(handleCreateSubchat).toHaveBeenCalledTimes(1);
    expect(createButton?.disabled).toBe(true);
    expect(cancelButton?.disabled).toBe(true);

    await act(async () => finishCreation?.(false));

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(createButton?.disabled).toBe(false);
  });

  it('lets the user overwrite the current chat title', async () => {
    const handleRenameSubchat = vi.fn().mockResolvedValue(true);
    const onSubchatTitleChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <SubchatBar
          subchats={[subchat(0, 'Pocket Poll')]}
          currentSubchatIndex={0}
          isStreaming={false}
          chatDisabled={false}
          sessionId="session"
          handleCreateSubchat={() => Promise.resolve(true)}
          handleRenameSubchat={handleRenameSubchat}
          onSubchatTitleChange={onSubchatTitleChange}
          isSubchatLoaded
        />,
      );
    });

    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Rename current chat: Pocket Poll"]')?.click();
    });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Chat title"]');
    expect(input?.value).toBe('Pocket Poll');

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'Team Voting');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Save title',
    );
    await act(async () => saveButton?.click());

    expect(handleRenameSubchat).toHaveBeenCalledWith('Team Voting');
    expect(onSubchatTitleChange).toHaveBeenCalledWith(0, 'Team Voting');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

function renderSubchatBar({
  subchats,
  currentSubchatIndex,
}: {
  subchats: ReturnType<typeof subchat>[];
  currentSubchatIndex: number;
}) {
  return renderToStaticMarkup(
    <SubchatBar
      subchats={subchats}
      currentSubchatIndex={currentSubchatIndex}
      isStreaming={false}
      chatDisabled={false}
      sessionId="session"
      handleCreateSubchat={() => Promise.resolve(true)}
      handleRenameSubchat={() => Promise.resolve(true)}
      isSubchatLoaded
    />,
  );
}

function subchat(subchatIndex: number, description: string) {
  return {
    subchatIndex,
    description,
    updatedAt: subchatIndex,
    transcript: {
      agentName: `chat-${subchatIndex}`,
      generation: 0,
      subchatIndex,
    },
  };
}
