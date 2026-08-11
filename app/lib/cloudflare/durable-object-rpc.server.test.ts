import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryDurableObjectRpc } from './durable-object-rpc.server';

const wait = vi.fn().mockResolvedValue(undefined);

afterEach(() => {
  vi.unstubAllGlobals();
  wait.mockClear();
});

describe('retryDurableObjectRpc', () => {
  it('retries a retryable RPC with a fresh call', async () => {
    vi.stubGlobal('scheduler', { wait });
    const transient = Object.assign(new Error('temporary Durable Object failure'), { retryable: true });
    const call = vi.fn().mockRejectedValueOnce(transient).mockResolvedValue('ready');

    await expect(retryDurableObjectRpc(call)).resolves.toBe('ready');

    expect(call).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it.each(['Durable Object reset because its code was updated', 'Container service disconnected.'])(
    'retries a transport reset even when the runtime omits retryable metadata: %s',
    async (message) => {
      vi.stubGlobal('scheduler', { wait });
      const reset = new Error(message);
      const call = vi.fn().mockRejectedValueOnce(reset).mockResolvedValue('ready');

      await expect(retryDurableObjectRpc(call)).resolves.toBe('ready');
      expect(call).toHaveBeenCalledTimes(2);
    },
  );

  it('does not retry overloads or application failures', async () => {
    vi.stubGlobal('scheduler', { wait });
    const overloaded = Object.assign(new Error('Durable Object overloaded'), {
      retryable: true,
      overloaded: true,
    });
    const overloadedCall = vi.fn().mockRejectedValue(overloaded);
    const applicationError = new Error('Chat transcript not found');
    const applicationCall = vi.fn().mockRejectedValue(applicationError);

    await expect(retryDurableObjectRpc(overloadedCall)).rejects.toBe(overloaded);
    await expect(retryDurableObjectRpc(applicationCall)).rejects.toBe(applicationError);

    expect(overloadedCall).toHaveBeenCalledOnce();
    expect(applicationCall).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it('throws after three failed attempts', async () => {
    vi.stubGlobal('scheduler', { wait });
    const transient = Object.assign(new Error('temporary Durable Object failure'), { retryable: true });
    const call = vi.fn().mockRejectedValue(transient);

    await expect(retryDurableObjectRpc(call)).rejects.toBe(transient);

    expect(call).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
