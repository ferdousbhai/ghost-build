import { beforeEach, describe, expect, test, vi } from 'vitest';

const getPiModel = vi.hoisted(() => vi.fn(() => ({ model: { id: 'workers-ai-model' }, stream: vi.fn() })));
vi.mock('./pi-ai-models', () => ({ getPiModel }));

import { getProvider, getPiProvider } from './provider';

describe('Workers AI provider (Pi)', () => {
  beforeEach(() => vi.clearAllMocks());

  test('uses the connected account credential with Pi ModelHandle', () => {
    const credentials = { accountId: 'account-1', apiKey: 'oauth-token' };
    getProvider({} as Env, credentials, '@cf/zai-org/glm-5.2', {
      sessionAffinity: 'gb-opaque',
      feature: 'builder-chat',
    });

    expect(getPiModel).toHaveBeenCalledWith(credentials, '@cf/zai-org/glm-5.2', expect.objectContaining({ sessionAffinity: 'gb-opaque' }));
  });

  test('passes a Cloudflare catalog partner slug through Pi provider', () => {
    const creds = { accountId: 'account-1', apiKey: 'oauth-token' };
    getPiProvider(creds, 'deepseek/deepseek-v4-pro', { sessionAffinity: 'gb-opaque' });
    expect(getPiModel).toHaveBeenCalledWith(creds, 'deepseek/deepseek-v4-pro', expect.objectContaining({ sessionAffinity: 'gb-opaque' }));
  });
});
