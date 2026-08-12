import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMessageInputPrimaryAction,
  getMessageInputPrimaryActionLabel,
  preservePromptForAuthentication,
  replacePromptIfUnchanged,
  submitMessageInput,
} from './useMessageInputController';
import { messageInputStore } from '~/lib/stores/messageInput';
import { PENDING_PROMPT_STORAGE_KEY } from '~/utils/constants';

afterEach(() => {
  messageInputStore.set('');
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

describe('getMessageInputPrimaryAction', () => {
  it('routes keyboard and button submission through authentication before starting a chat', () => {
    expect(getMessageInputPrimaryAction('loading', false)).toBe('wait');
    expect(getMessageInputPrimaryAction('unauthenticated', false)).toBe('sign-in');
    expect(getMessageInputPrimaryAction('fullyLoggedIn', false)).toBe('send');
    expect(getMessageInputPrimaryAction('unauthenticated', true)).toBe('stop');
    expect(getMessageInputPrimaryAction('fullyLoggedIn', true, true)).toBe('send');
    expect(getMessageInputPrimaryActionLabel('unauthenticated', false)).toBe('Connect Cloudflare');
    expect(getMessageInputPrimaryActionLabel('fullyLoggedIn', false)).toBe('Send');
    expect(getMessageInputPrimaryActionLabel('unauthenticated', true)).toBe('Stop');
    expect(getMessageInputPrimaryActionLabel('fullyLoggedIn', true, true)).toBe('Send');
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

  it('removes a stale handoff when the current prompt is empty', () => {
    const storage = new Map([[PENDING_PROMPT_STORAGE_KEY, 'stale prompt']]);
    vi.stubGlobal('window', {
      sessionStorage: {
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });

    preservePromptForAuthentication('   ');

    expect(storage.has(PENDING_PROMPT_STORAGE_KEY)).toBe(false);
  });
});

describe('replacePromptIfUnchanged', () => {
  it('does not overwrite input edited while prompt enhancement was in flight', () => {
    messageInputStore.set('new user input');

    expect(replacePromptIfUnchanged('original input', 'enhanced original')).toBe(false);
    expect(messageInputStore.get()).toBe('new user input');
  });

  it('applies the enhancement when the source input is still current', () => {
    messageInputStore.set('original input');

    expect(replacePromptIfUnchanged('original input', 'enhanced original')).toBe(true);
    expect(messageInputStore.get()).toBe('enhanced original');
  });
});
