// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptRefinementDialog } from './PromptRefinementDialog.client';

let root: Root | undefined;

const questions = [
  {
    id: 'audience',
    header: 'Audience',
    question: 'Who is this app primarily for?',
    options: [
      { id: 'team', label: 'Internal team', description: 'Access is limited to team members.' },
      { id: 'public', label: 'Public visitors', description: 'Anyone can use the main experience.' },
    ],
    multi: false,
    recommendedOptionId: 'team',
  },
  {
    id: 'views',
    header: 'Views',
    question: 'Which calendar views matter?',
    options: [
      { id: 'month', label: 'Month', description: 'Plan across the full month.' },
      { id: 'week', label: 'Week', description: 'Focus on the current week.' },
    ],
    multi: true,
    recommendedOptionId: 'month',
  },
];

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

async function renderDialog(renderedQuestions = questions, onSubmit = vi.fn(), onCancel = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <PromptRefinementDialog
        questions={renderedQuestions}
        isLoading={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
  });
  return { onSubmit, onCancel };
}

function buttonContaining(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text),
  );
}

async function enterTextarea(selector: string, value: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>(selector);
  await act(async () => {
    if (!textarea) {
      return;
    }
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('PromptRefinementDialog', () => {
  it('collects a related question batch with navigation and multi-select', async () => {
    const { onSubmit } = await renderDialog();
    const recommended = buttonContaining('Internal team');

    expect(recommended?.textContent).toContain('Recommended');
    await act(async () => recommended?.click());
    await act(async () => buttonContaining('Add a clarification note')?.click());
    await enterTextarea('#prompt-refinement-note', 'Guests may view calendars through a public link.');
    await act(async () => buttonContaining('Next decision')?.click());

    expect(document.body.textContent).toContain('Decision 2 of 2');
    expect(document.body.textContent).toContain('Choose all that apply');
    await act(async () => buttonContaining('Month')?.click());
    await act(async () => buttonContaining('Week')?.click());
    await act(async () => buttonContaining('Submit answers')?.click());

    expect(onSubmit).toHaveBeenCalledWith([
      {
        questionId: 'audience',
        question: 'Who is this app primarily for?',
        selectedOptions: ['Internal team'],
        note: 'Guests may view calendars through a public link.',
      },
      {
        questionId: 'views',
        question: 'Which calendar views matter?',
        selectedOptions: ['Month', 'Week'],
      },
    ]);
  });

  it('shows custom input directly and supports explicit cancellation', async () => {
    const { onSubmit, onCancel } = await renderDialog([questions[0]!]);

    expect(document.querySelector('#prompt-refinement-custom-answer')).not.toBeNull();

    await act(async () => buttonContaining('Internal team')?.click());
    await enterTextarea('#prompt-refinement-custom-answer', 'Teachers and their students');
    await act(async () => buttonContaining('Submit answers')?.click());
    expect(onSubmit).toHaveBeenCalledWith([
      {
        questionId: 'audience',
        question: 'Who is this app primarily for?',
        selectedOptions: [],
        customInput: 'Teachers and their students',
      },
    ]);

    await act(async () => buttonContaining('Cancel refinement')?.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
