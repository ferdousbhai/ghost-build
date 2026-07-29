import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SubchatBar } from './SubchatBar';

vi.mock('~/lib/stores/fileUpdateCounter', () => ({
  useAreFilesSaving: () => false,
}));

describe('SubchatBar', () => {
  it('does not present a useless history picker or navigation for a single chat', () => {
    const markup = renderSubchatBar({
      subchats: [subchat(0, 'Build a polished Pocket Poll app')],
      currentSubchatIndex: 0,
    });

    expect(markup).toContain('Current chat');
    expect(markup).toContain('Build a polished Pocket Poll app');
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
    expect(markup).toContain('Chat 2 of 2');
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
      handleCreateSubchat={() => undefined}
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
