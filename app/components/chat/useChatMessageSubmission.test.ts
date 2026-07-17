import { describe, expect, it, vi } from 'vitest';
import { runChatSubmissionLifecycle } from './useChatMessageSubmission';

describe('runChatSubmissionLifecycle', () => {
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
