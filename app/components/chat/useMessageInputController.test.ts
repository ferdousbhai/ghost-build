import Cookies from 'js-cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preservePromptForAuthentication, submitMessageInput } from './useMessageInputController';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('submitMessageInput', () => {
  it('keeps the prompt when submission is rejected', async () => {
    const onAccepted = vi.fn();
    const onSend = vi.fn().mockResolvedValue(false);

    await expect(submitMessageInput('  keep this prompt  ', onSend, onAccepted)).resolves.toBe(false);

    expect(onSend).toHaveBeenCalledWith('keep this prompt');
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('clears the prompt only after submission is accepted', async () => {
    const onAccepted = vi.fn();
    const onSend = vi.fn().mockResolvedValue(true);

    await expect(submitMessageInput('send this', onSend, onAccepted)).resolves.toBe(true);

    expect(onAccepted).toHaveBeenCalledOnce();
  });
});

describe('preservePromptForAuthentication', () => {
  it('writes the current prompt synchronously before OAuth navigation', () => {
    const setCookie = vi.spyOn(Cookies, 'set').mockReturnValue('');

    preservePromptForAuthentication('  A todo app  ');

    expect(setCookie).toHaveBeenCalledWith('cachedPrompt', 'A todo app', { expires: 30 });
  });
});
