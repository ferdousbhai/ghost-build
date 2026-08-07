import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPiModel: vi.fn(() => ({ model: { id: 'title-model' }, stream: vi.fn() })),
  titleGeneration: vi.fn(),
}));

vi.mock('./pi-ai-models', () => ({ getPiModel: mocks.getPiModel }));
vi.mock('@summonghost/title-generation', () => ({
  generateTitle: (...args: unknown[]) => mocks.titleGeneration(...args),
}));

import { generateProjectTitle } from './project-title';
import { CLOUDFLARE_PROJECT_TITLE_MODEL } from '~/lib/workers-ai-model';

describe('generateProjectTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.titleGeneration.mockResolvedValue({ title: 'Cloudflare Verification App' });
  });

  it('uses the connected account with the small title model', async () => {
    const credentials = { accountId: 'account-1', apiKey: 'token' };
    const env = {} as Env;
    return expect(generateProjectTitle(env, 'Build a verification app', credentials)).resolves.toBe(
      'Cloudflare Verification App',
    );
  });

  it('propagates provider failures', async () => {
    mocks.titleGeneration.mockRejectedValue(new Error('model unavailable'));
    await expect(
      generateProjectTitle({} as Env, 'Build a calendar', { accountId: 'account-1', apiKey: 'token' }),
    ).rejects.toThrow('model unavailable');
  });
});
