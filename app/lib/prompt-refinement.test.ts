import { describe, expect, it } from 'vitest';
import {
  promptRefinementQuestionSchema,
  promptRefinementRequestSchema,
  recommendedOptionFirst,
} from './prompt-refinement';

const question = {
  id: 'audience',
  header: 'Audience',
  question: 'Who is this app primarily for?',
  options: [
    { id: 'public', label: 'Public visitors', description: 'Anyone can use the main experience.' },
    { id: 'team', label: 'Internal team', description: 'Access is limited to team members.' },
  ],
  multi: false,
  recommendedOptionId: 'team',
};

describe('prompt refinement protocol', () => {
  it('puts the recommended option first without changing the remaining order', () => {
    const parsed = promptRefinementQuestionSchema.parse(question);

    expect(recommendedOptionFirst(parsed).options.map((option) => option.id)).toEqual(['team', 'public']);
  });

  it('rejects duplicate or missing recommended option IDs', () => {
    expect(
      promptRefinementQuestionSchema.safeParse({
        ...question,
        options: [question.options[0], { ...question.options[1], id: question.options[0].id }],
      }).success,
    ).toBe(false);
    expect(promptRefinementQuestionSchema.safeParse({ ...question, recommendedOptionId: 'missing' }).success).toBe(
      false,
    );
  });

  it('rejects repeated questions and accepts adaptive interview length within the request-size boundary', () => {
    const repeatedAnswer = {
      questionId: 'audience',
      question: question.question,
      selectedOptions: ['Internal team'],
    };

    expect(
      promptRefinementRequestSchema.safeParse({ prompt: 'Build an app', answers: [repeatedAnswer, repeatedAnswer] })
        .success,
    ).toBe(false);
    expect(
      promptRefinementRequestSchema.safeParse({
        prompt: 'Build an app',
        answers: Array.from({ length: 12 }, (_, index) => ({
          questionId: `question-${index}`,
          question: `Question ${index}`,
          selectedOptions: [`Answer ${index}`],
        })),
      }).success,
    ).toBe(true);
  });

  it('accepts either selected options or custom input but not both', () => {
    const base = { questionId: 'audience', question: question.question };

    expect(
      promptRefinementRequestSchema.safeParse({
        prompt: 'Build an app',
        answers: [{ ...base, selectedOptions: ['Internal team'], note: 'Guests can use shared links.' }],
      }).success,
    ).toBe(true);
    expect(
      promptRefinementRequestSchema.safeParse({
        prompt: 'Build an app',
        answers: [{ ...base, customInput: 'Teachers and their students' }],
      }).success,
    ).toBe(true);
    expect(
      promptRefinementRequestSchema.safeParse({
        prompt: 'Build an app',
        answers: [{ ...base, selectedOptions: ['Internal team'], customInput: 'Teachers' }],
      }).success,
    ).toBe(false);
  });
});
