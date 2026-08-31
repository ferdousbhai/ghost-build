// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatDescription } from './ChatDescription.client';

vi.mock('@nanostores/react', () => ({
  useStore: () => 'Car Racing Game',
}));

vi.mock('~/lib/hooks/useEditChatDescription', () => ({
  useEditChatDescription: () => ({
    editing: false,
    handleChange: vi.fn(),
    handleBlur: vi.fn(),
    handleSubmit: vi.fn(),
    handleKeyDown: vi.fn(),
    currentDescription: 'Car Racing Game',
    toggleEditMode: vi.fn(),
  }),
}));

describe('ChatDescription', () => {
  it('uses the project title as the rename trigger and hides the pencil until interaction', () => {
    document.body.innerHTML = renderToStaticMarkup(<ChatDescription />);

    const renameButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename project: Car Racing Game"]',
    );
    const layoutRoot = renameButton?.parentElement;

    expect(layoutRoot?.classList).toContain('min-w-0');
    expect(layoutRoot?.classList).toContain('w-full');
    expect(renameButton?.classList).toContain('bg-transparent');
    expect(renameButton?.classList).toContain('min-w-0');
    expect(renameButton?.classList).toContain('max-w-full');
    expect(renameButton?.classList).toContain('text-content-primary');
    expect(renameButton?.textContent).toContain('Car Racing Game');
    const title = renameButton?.querySelector('span');
    expect(title?.classList).not.toContain('group-hover:underline');
    expect(title?.classList).not.toContain('max-w-64');
    expect(title?.classList).toContain('flex-1');
    expect(renameButton?.querySelector('svg')?.classList).toContain('opacity-0');
    expect(document.querySelectorAll('button')).toHaveLength(1);
  });
});
