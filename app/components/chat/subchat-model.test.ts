import { describe, expect, it } from 'vitest';
import { applyLiveSubchatTitle, createSubchatOptions, getSubchatLabel, getSubchatNavigation } from './subchat-model';

describe('subchat model', () => {
  it('creates stable fallback labels', () => {
    expect(
      createSubchatOptions([
        { subchatIndex: 0, updatedAt: 1, transcript: transcript(0) },
        { subchatIndex: 1, updatedAt: 2, description: 'Billing', transcript: transcript(1) },
      ]).map(({ label }) => label),
    ).toEqual(['Initial chat', 'Billing']);
    expect(getSubchatLabel(3, '   ')).toBe('Feature #3');
  });

  it('derives navigation and creation permissions', () => {
    expect(getSubchatNavigation(3, 1, true)).toMatchObject({
      canNavigatePrev: true,
      canNavigateNext: true,
      canCreateSubchat: false,
    });
    expect(getSubchatNavigation(3, 2, true).canCreateSubchat).toBe(true);
  });

  it('keeps a persisted manual title when a stale generated title is replayed', () => {
    const persisted = [
      {
        subchatIndex: 0,
        updatedAt: 1,
        description: 'Team Voting',
        transcript: transcript(0),
      },
    ];

    expect(applyLiveSubchatTitle(persisted, { subchatIndex: 0, title: 'Pocket Poll' }, transcript(0))).toBe(persisted);
  });

  it('uses a live title while the persisted title is still empty', () => {
    const subchats = [{ subchatIndex: 0, updatedAt: 1, transcript: transcript(0) }];

    expect(
      applyLiveSubchatTitle(subchats, { subchatIndex: 0, title: 'Pocket Poll' }, transcript(0))?.[0]?.description,
    ).toBe('Pocket Poll');
  });
});

function transcript(subchatIndex: number) {
  return { agentName: `chat-${subchatIndex}`, generation: 0, subchatIndex };
}
