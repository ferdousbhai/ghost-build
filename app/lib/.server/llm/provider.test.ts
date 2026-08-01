import { beforeEach, describe, expect, test, vi } from 'vitest';

const createWorkersAI = vi.hoisted(() => vi.fn(() => vi.fn(() => ({ modelId: 'workers-ai-model' }))));
vi.mock('workers-ai-provider', () => ({ createWorkersAI }));

import { getProvider } from './provider';

describe('Workers AI provider', () => {
  beforeEach(() => vi.clearAllMocks());

  test('always uses the connected account credential rather than an AI binding', () => {
    const credentials = { accountId: 'account-1', apiKey: 'oauth-token' };
    getProvider({} as Env, credentials, '@cf/zai-org/glm-5.2', { sessionAffinity: 'gb-opaque' });

    expect(createWorkersAI).toHaveBeenCalledWith({
      ...credentials,
      gateway: { id: 'default', collectLog: true },
    });
  });
});
