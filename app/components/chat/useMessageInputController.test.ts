import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPromptIfUnchanged,
  getMessageInputPrimaryAction,
  getMessageInputPrimaryActionLabel,
  hasFailedCloudflareAuthorization,
  preservePromptForAuthentication,
  shouldContinuePendingSubmit,
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

describe('clearPromptIfUnchanged', () => {
  it('preserves a newer draft and its authentication handoff when an older send is accepted', () => {
    const storage = new Map([[PENDING_PROMPT_STORAGE_KEY, 'new user input']]);
    vi.stubGlobal('window', {
      sessionStorage: {
        removeItem: (key: string) => storage.delete(key),
      },
    });
    setMessageInput('new user input');

    expect(clearPromptIfUnchanged('sent input', getMessageInputRevision())).toBe(false);
    expect(messageInputStore.get()).toBe('new user input');
    expect(storage.get(PENDING_PROMPT_STORAGE_KEY)).toBe('new user input');
  });

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
  it('does not overwrite input edited while prompt enhancement was in flight', () => {
    setMessageInput('original input');
    const sourceRevision = getMessageInputRevision();
    setMessageInput('new user input');

    expect(replacePromptIfUnchanged('original input', sourceRevision, 'enhanced original')).toBe(false);
    expect(messageInputStore.get()).toBe('new user input');
  });

  it('does not overwrite input changed away and back while prompt enhancement was in flight', () => {
    setMessageInput('original input');
    const sourceRevision = getMessageInputRevision();
    setMessageInput('temporary edit');
    setMessageInput('original input');

    expect(replacePromptIfUnchanged('original input', sourceRevision, 'enhanced original')).toBe(false);
    expect(messageInputStore.get()).toBe('original input');
  });

  it('applies the enhancement when the source input and revision are still current', () => {
    setMessageInput('original input');
    const sourceRevision = getMessageInputRevision();

    expect(replacePromptIfUnchanged('original input', sourceRevision, 'enhanced original')).toBe(true);
    expect(messageInputStore.get()).toBe('enhanced original');
  });
});

describe('shouldContinuePendingSubmit', () => {
  const connected = {
    authKind: 'fullyLoggedIn',
    pendingSubmit: 'Build a launch checklist.',
    prompt: 'Build a launch checklist.',
    authorizationFailed: false,
  } as const;

  it('finishes the submit that asked for the connection', () => {
    expect(shouldContinuePendingSubmit(connected)).toBe(true);
    expect(shouldContinuePendingSubmit({ ...connected, prompt: '  Build a launch checklist.  ' })).toBe(true);
  });

  it('never starts a build for a connection no submit asked for', () => {
    // Connecting from settings or from a bare sign-in screen leaves nothing pending.
    expect(shouldContinuePendingSubmit({ ...connected, pendingSubmit: null })).toBe(false);
  });

  it('does not resend a prompt the person changed while connecting', () => {
    expect(shouldContinuePendingSubmit({ ...connected, prompt: 'Build a launch checklist for the team.' })).toBe(false);
    expect(shouldContinuePendingSubmit({ ...connected, prompt: '' })).toBe(false);
  });

  it('stays put after a failed or cancelled authorization', () => {
    expect(shouldContinuePendingSubmit({ ...connected, authorizationFailed: true })).toBe(false);
    expect(shouldContinuePendingSubmit({ ...connected, authKind: 'unauthenticated' })).toBe(false);
  });
});

describe('hasFailedCloudflareAuthorization', () => {
  it('reads the marker Cloudflare recovery puts on the return URL', () => {
    expect(hasFailedCloudflareAuthorization('?cloudflare_authorization=failed')).toBe(true);
    expect(hasFailedCloudflareAuthorization('?prefill=hello')).toBe(false);
    expect(hasFailedCloudflareAuthorization('')).toBe(false);
  });
});
