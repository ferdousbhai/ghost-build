import { describe, expect, it, vi } from 'vitest';
import { setGeneratedDescriptionIfMissing } from './chat-service.server';

describe('setGeneratedDescriptionIfMissing', () => {
  it('sets a generated title only through an owner-scoped conditional update', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));

    await expect(
      setGeneratedDescriptionIfMissing({ prepare } as unknown as D1Database, {
        sessionId: 'user-1',
        id: 'chat-1',
        description: 'Cloudflare Verification App',
      }),
    ).resolves.toBe(true);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("NULLIF(TRIM(description), '') IS NULL"));
    expect(bind).toHaveBeenCalledWith('Cloudflare Verification App', 'user-1', 'chat-1', 'chat-1');
  });

  it('does not overwrite a title that already exists', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run })) })),
    } as unknown as D1Database;

    await expect(
      setGeneratedDescriptionIfMissing(db, {
        sessionId: 'user-1',
        id: 'chat-1',
        description: 'Generated title',
      }),
    ).resolves.toBe(false);
  });
});
