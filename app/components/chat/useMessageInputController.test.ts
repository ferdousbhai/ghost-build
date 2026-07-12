import { describe, expect, it, vi } from 'vitest';
import { submitMessageInput } from './useMessageInputController';

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
