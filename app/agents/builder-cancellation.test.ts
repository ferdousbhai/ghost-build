import { describe, expect, it, vi } from 'vitest';
import { waitForCancellationBeforeDeadline } from './builder-cancellation';

describe('bounded builder cancellation', () => {
  it('returns when cancellation settles before the deadline', async () => {
    const wait = vi.fn(() => new Promise<void>(() => undefined));

    await expect(waitForCancellationBeforeDeadline(Promise.resolve(), Date.now() + 10_000, wait)).resolves.toBe(
      undefined,
    );
  });

  it('rejects at the deadline when cancellation never settles', async () => {
    const cancellation = new Promise<void>(() => undefined);
    const wait = vi.fn(async () => undefined);

    await expect(waitForCancellationBeforeDeadline(cancellation, Date.now() + 10_000, wait)).rejects.toThrow(
      'Builder cancellation did not settle before the cancellation timeout.',
    );
    expect(wait).toHaveBeenCalledOnce();
  });
});
