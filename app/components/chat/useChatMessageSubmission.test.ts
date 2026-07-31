import { describe, expect, it, vi } from 'vitest';
import { appendPendingUserMessage, runChatSubmissionLifecycle } from './useChatMessageSubmission';

describe('runChatSubmissionLifecycle', () => {
  it.each([
    ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'],
    ['iPad Safari', 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'],
    ['Android Chrome', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/138 Mobile'],
    ['Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'],
  ])('creates and dispatches the first prompt on %s without a browser execution runtime', async (_name, userAgent) => {
    vi.stubGlobal('navigator', { userAgent });
    const initializeChat = vi.fn(async () => ({ created: true }));
    const submit = vi.fn(async (onRequestStart: () => void) => onRequestStart());

    await runChatSubmissionLifecycle({
      initializeChat,
      discardEmptyChat: vi.fn(),
      onStartChat: vi.fn(),
      onBuilderRequestStart: vi.fn(),
      submit,
    });

    expect(initializeChat).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('does not let a cosmetic transition block the builder request', async () => {
    const submit = vi.fn(async (onRequestStart: () => void) => onRequestStart());
    const onBuilderRequestStart = vi.fn();

    await expect(
      runChatSubmissionLifecycle({
        initializeChat: async () => ({ created: true }),
        discardEmptyChat: vi.fn(),
        onStartChat: () => new Promise(() => undefined),
        onBuilderRequestStart,
        submit,
      }),
    ).resolves.toBeUndefined();

    expect(submit).toHaveBeenCalledOnce();
    expect(onBuilderRequestStart).toHaveBeenCalledOnce();
  });

  it('discards a newly created draft when preflight fails before dispatch', async () => {
    const discardEmptyChat = vi.fn().mockResolvedValue(undefined);

    await expect(
      runChatSubmissionLifecycle({
        initializeChat: async () => ({ created: true }),
        discardEmptyChat,
        onStartChat: vi.fn(),
        onBuilderRequestStart: vi.fn(),
        submit: async () => {
          throw new Error('connection failed');
        },
      }),
    ).rejects.toThrow('connection failed');

    expect(discardEmptyChat).toHaveBeenCalledOnce();
  });

  it('keeps the chat once the builder request has been dispatched', async () => {
    const discardEmptyChat = vi.fn().mockResolvedValue(undefined);

    await expect(
      runChatSubmissionLifecycle({
        initializeChat: async () => ({ created: true }),
        discardEmptyChat,
        onStartChat: vi.fn(),
        onBuilderRequestStart: vi.fn(),
        submit: async (onRequestStart) => {
          onRequestStart();
          throw new Error('stream failed');
        },
      }),
    ).rejects.toThrow('stream failed');

    expect(discardEmptyChat).not.toHaveBeenCalled();
  });
});

describe('appendPendingUserMessage', () => {
  const pending = {
    id: 'pending-1',
    text: 'Build a calendar',
    previousUserMessageCount: 0,
  };

  it('renders an accepted prompt before the chat transport appends it', () => {
    expect(appendPendingUserMessage([], pending)).toEqual([
      {
        id: 'pending-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Build a calendar' }],
      },
    ]);
  });

  it('removes the optimistic copy after the transport message is visible', () => {
    const messages = [
      {
        id: 'user-1',
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: 'Build a calendar' }],
      },
    ];

    expect(appendPendingUserMessage(messages, pending)).toBe(messages);
  });
});
