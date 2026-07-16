import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AiAllowanceRepository from '~/lib/.server/billing/ai-allowance-repository';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getProvider: vi.fn(() => ({ model: { modelId: 'title-model' } })),
  reserve: vi.fn(),
  settle: vi.fn(),
  release: vi.fn(),
}));

vi.mock('ai', () => ({ generateText: mocks.generateText }));
vi.mock('./provider', () => ({ getProvider: mocks.getProvider }));
vi.mock('~/lib/.server/billing/ai-allowance-repository', async (importOriginal) => {
  const original = await importOriginal<typeof AiAllowanceRepository>();
  return {
    ...original,
    reserveAiAllowance: mocks.reserve,
    settleAiAllowance: mocks.settle,
    releaseAiAllowance: mocks.release,
  };
});

import { cleanProjectTitle, generateProjectTitle } from './project-title';
import { CLOUDFLARE_PROJECT_TITLE_MODEL } from '~/lib/workers-ai-model';

describe('generateProjectTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reserve.mockResolvedValue({ id: 'title-reservation' });
    mocks.release.mockResolvedValue(undefined);
    mocks.generateText.mockResolvedValue({
      text: '  "Cloudflare Verification App"  ',
      totalUsage: { inputTokens: 18, outputTokens: 5 },
      providerMetadata: {},
    });
  });

  it('uses the small title model and accounts for Ghostbuild-funded inference', async () => {
    const env = { DB: {} } as Env;
    await expect(generateProjectTitle(env, 'Build a verification app', undefined, 'guest:one')).resolves.toBe(
      'Cloudflare Verification App',
    );
    expect(mocks.getProvider).toHaveBeenCalledWith(env, undefined, CLOUDFLARE_PROJECT_TITLE_MODEL);
    expect(mocks.reserve).toHaveBeenCalledWith(env.DB, 'guest:one', expect.any(Number));
    expect(mocks.settle).toHaveBeenCalledWith(env.DB, 'title-reservation', expect.any(Number), {
      inputTokens: 18,
      cachedInputTokens: 0,
      outputTokens: 5,
    });
  });

  it('charges a connected account without consuming Ghostbuild allowance', async () => {
    const credentials = { accountId: 'account-1', apiKey: 'token' };
    await generateProjectTitle({ DB: {} } as Env, 'Build a calendar', credentials, 'user:one');
    expect(mocks.getProvider).toHaveBeenCalledWith(expect.anything(), credentials, CLOUDFLARE_PROJECT_TITLE_MODEL);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('releases an allowance reservation when title generation fails', async () => {
    mocks.generateText.mockRejectedValue(new Error('model unavailable'));
    await expect(generateProjectTitle({ DB: {} } as Env, 'Build a calendar', undefined, 'guest:one')).rejects.toThrow(
      'model unavailable',
    );
    expect(mocks.release).toHaveBeenCalledWith({}, 'title-reservation');
  });
});

describe('cleanProjectTitle', () => {
  it('removes common model framing and ignores extra lines', () => {
    expect(cleanProjectTitle('Project title: "Team Planning Calendar."\nHope this helps')).toBe(
      'Team Planning Calendar',
    );
  });

  it('bounds unexpectedly long output without adding punctuation', () => {
    const title = cleanProjectTitle(
      'A very long generated project title that keeps going far beyond the desired limit',
    );
    expect(title).toBeTruthy();
    expect(title!.length).toBeLessThanOrEqual(60);
  });

  it('rejects empty output', () => {
    expect(cleanProjectTitle('  ""  ')).toBeNull();
  });
});
