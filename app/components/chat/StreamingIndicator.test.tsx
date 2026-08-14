import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { chatStore } from '~/lib/stores/chatId';
import StreamingIndicator from './StreamingIndicator';

afterEach(() => {
  chatStore.set({ started: false, aborted: false, showChat: true });
});

describe('StreamingIndicator', () => {
  const render = () =>
    renderToStaticMarkup(
      <StreamingIndicator
        streamStatus="ready"
        buildProgress={null}
        isProjectUpdate
        submissionPending={false}
        resendMessage={vi.fn()}
      />,
    );

  it('hides the redundant completed state', () => {
    expect(render()).toBe('');
  });

  it('keeps the stopped state and retry action visible after the stream settles', () => {
    chatStore.setKey('aborted', true);

    const html = render();

    expect(html).toContain('Generation stopped');
    expect(html).toContain('Try again');
  });

  it('offers to resend after a stream error', () => {
    const html = renderToStaticMarkup(
      <StreamingIndicator
        streamStatus="error"
        buildProgress={null}
        isProjectUpdate
        submissionPending={false}
        resendMessage={vi.fn()}
      />,
    );

    expect(html).toContain('Resend');
  });
});
