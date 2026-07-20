import { describe, expect, it } from 'vitest';
import { createSubchatOptions, getSubchatNavigation } from './subchat-model';

describe('subchat model', () => {
  it('creates stable fallback labels', () => {
    expect(
      createSubchatOptions([
        { subchatIndex: 0, updatedAt: 1, transcript: transcript(0) },
        { subchatIndex: 1, updatedAt: 2, description: 'Billing', transcript: transcript(1) },
      ]).map(({ label }) => label),
    ).toEqual(['Initial chat', 'Billing']);
  });

  it('derives navigation and creation permissions', () => {
    expect(getSubchatNavigation(3, 1, true)).toMatchObject({
      canNavigatePrev: true,
      canNavigateNext: true,
      canCreateSubchat: false,
    });
    expect(getSubchatNavigation(3, 2, true).canCreateSubchat).toBe(true);
  });
});

function transcript(subchatIndex: number) {
  return { agentName: `chat-${subchatIndex}`, generation: 0, subchatIndex };
}
