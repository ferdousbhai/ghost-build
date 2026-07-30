import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getProvider: vi.fn(() => ({ model: { modelId: 'title-model' } })),
}));

vi.mock('ai', () => ({ generateText: mocks.generateText }));
vi.mock('./provider', () => ({ getProvider: mocks.getProvider }));

import { generateProjectTitle } from './project-title';
import { CLOUDFLARE_PROJECT_TITLE_MODEL } from '~/lib/workers-ai-model';

describe('generateProjectTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateText.mockResolvedValue({ text: '  "Cloudflare Verification App"  ' });
  });

  it('uses the connected account with the small title model', async () => {
    const credentials = { accountId: 'account-1', apiKey: 'token' };
    const env = {} as Env;
    await expect(generateProjectTitle(env, 'Build a verification app', credentials)).resolves.toBe(
      'Cloudflare Verification App',
    );
    expect(mocks.getProvider).toHaveBeenCalledWith(env, credentials, CLOUDFLARE_PROJECT_TITLE_MODEL);
  });

  it('propagates provider failures', async () => {
    mocks.generateText.mockRejectedValue(new Error('model unavailable'));
    await expect(
      generateProjectTitle({} as Env, 'Build a calendar', { accountId: 'account-1', apiKey: 'token' }),
    ).rejects.toThrow('model unavailable');
  });
});
