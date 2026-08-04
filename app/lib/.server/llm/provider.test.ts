import { beforeEach, describe, expect, test, vi } from 'vitest';

const createLanguageModel = vi.hoisted(() => vi.fn(() => ({ modelId: 'workers-ai-model' })));
const createWorkersAI = vi.hoisted(() => vi.fn(() => createLanguageModel));
vi.mock('workers-ai-provider', () => ({ createWorkersAI }));

import { getProvider } from './provider';

describe('Workers AI provider', () => {
  beforeEach(() => vi.clearAllMocks());

  test('uses the connected account credential with AI Gateway logging disabled at every request layer', () => {
    const credentials = { accountId: 'account-1', apiKey: 'oauth-token' };
    getProvider({} as Env, credentials, '@cf/zai-org/glm-5.2', {
      sessionAffinity: 'gb-opaque',
      feature: 'builder-chat',
    });

    expect(createWorkersAI).toHaveBeenCalledWith({
      ...credentials,
      gateway: { id: 'default', collectLog: false },
    });
    expect(createLanguageModel).toHaveBeenCalledWith('@cf/zai-org/glm-5.2', {
      sessionAffinity: 'gb-opaque',
      metadata: {
        ghostbuild_feature: 'builder-chat',
        ghostbuild_source: 'user-runtime',
      },
      collectLog: false,
      extraHeaders: {
        'cf-aig-collect-log': 'false',
        'cf-aig-collect-log-payload': 'false',
      },
    });
  });

  test('passes a Cloudflare catalog partner slug through unchanged', () => {
    getProvider({} as Env, { accountId: 'account-1', apiKey: 'oauth-token' }, 'deepseek/deepseek-v4-pro', {
      sessionAffinity: 'gb-opaque',
      feature: 'builder-chat',
    });

    expect(createLanguageModel).toHaveBeenCalledWith(
      'deepseek/deepseek-v4-pro',
      expect.objectContaining({ sessionAffinity: 'gb-opaque' }),
    );
  });
});
