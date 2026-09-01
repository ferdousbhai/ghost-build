import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPromptIfUnchanged,
  preservePromptForAuthentication,
  replacePromptIfUnchanged,
  submitMessageInput,
} from './useMessageInputController';
import { getMessageInputRevision, messageInputStore, setMessageInput } from '~/lib/stores/messageInput';
import { PENDING_PROMPT_STORAGE_KEY } from '~/utils/constants';

afterEach(() => {
  setMessageInput('');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('submitMessageInput', () => {
  it('keeps the prompt when submission is rejected', async () => {
    const onAccepted = vi.fn();
    const onSend = vi.fn(async () => false);

    await expect(submitMessageInput('  keep this prompt  ', onSend, onAccepted)).resolves.toBe(false);

    expect(onSend).toHaveBeenCalledWith('keep this prompt', onAccepted);
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('accepts the prompt at request dispatch rather than stream completion', async () => {
    const onAccepted = vi.fn();
    let finish!: (accepted: boolean) => void;
    const onSend = vi.fn(
      (_message: string, accept: () => void = () => undefined) =>
        new Promise<boolean>((resolve) => {
          accept();
          finish = resolve;
        }),
    );
    const submission = submitMessageInput('send this', onSend, onAccepted);

    expect(onAccepted).toHaveBeenCalledOnce();
    finish(true);
    await expect(submission).resolves.toBe(true);
  });
});

describe('preservePromptForAuthentication', () => {
  it('writes the complete current prompt to tab-local storage before OAuth navigation', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const prompt = `A todo app ${'x'.repeat(16_000)}`;

    preservePromptForAuthentication(`  ${prompt}  `);

    expect(storage.get(PENDING_PROMPT_STORAGE_KEY)).toBe(prompt);
  });
});

describe('clearPromptIfUnchanged', () => {
  it('preserves a draft changed programmatically away and back to the submitted value', () => {
    setMessageInput('sent input');
    const submittedRevision = getMessageInputRevision();

    setMessageInput('programmatic draft');
    setMessageInput('sent input');

    expect(clearPromptIfUnchanged('sent input', submittedRevision)).toBe(false);
    expect(messageInputStore.get()).toBe('sent input');
  });
});

describe('replacePromptIfUnchanged', () => {
  it('does not overwrite input changed away and back while prompt enhancement was in flight', () => {
    setMessageInput('original input');
    const sourceRevision = getMessageInputRevision();
    setMessageInput('temporary edit');
    setMessageInput('original input');

    expect(replacePromptIfUnchanged('original input', sourceRevision, 'enhanced original')).toBe(false);
    expect(messageInputStore.get()).toBe('original input');
  });
});
