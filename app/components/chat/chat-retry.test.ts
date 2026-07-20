import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_RETRY_EXPIRY_MS,
  chatRetryState,
  getChatRetryState,
  recordChatFailure,
  resetChatRetryState,
} from './chat-retry';

describe('chat retry state', () => {
  beforeEach(() => {
    resetChatRetryState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expires relative to the latest failure instead of a mounted-component interval', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    recordChatFailure(true, 1_000);
    recordChatFailure(true, 1_000 + CHAT_RETRY_EXPIRY_MS - 1);

    expect(getChatRetryState(1_000 + CHAT_RETRY_EXPIRY_MS)).toMatchObject({ numFailures: 2 });
    expect(getChatRetryState(1_000 + 2 * CHAT_RETRY_EXPIRY_MS)).toEqual({
      numFailures: 0,
      nextRetry: 1_000 + 2 * CHAT_RETRY_EXPIRY_MS,
      lastFailureAt: null,
    });
  });

  it('starts a fresh sequence when recording after expiry', () => {
    recordChatFailure(false, 100);
    recordChatFailure(false, 100 + CHAT_RETRY_EXPIRY_MS);

    expect(chatRetryState.get()).toMatchObject({ numFailures: 1, lastFailureAt: 100 + CHAT_RETRY_EXPIRY_MS });
  });
});
