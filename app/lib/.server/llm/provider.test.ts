import { beforeEach, describe, expect, test, vi } from 'vitest';

const getPiModel = vi.hoisted(() => vi.fn(() => ({ model: { id: 'workers-ai-model' }, stream: vi.fn() })));
vi.mock('./pi-ai-models', () => ({ getPiModel }));

import { getPiProvider } from './provider';

describe('Workers AI provider (Pi)', () => {
  beforeEach(() => vi.clearAllMocks());

  test('uses the user-runtime binding with Pi ModelHandle', () => {
    const credentials = { binding: {} as Ai };
    getPiProvider(credentials, '@cf/zai-org/glm-5.2', { sessionAffinity: 'gb-opaque' });

    expect(getPiModel).toHaveBeenCalledWith(
      credentials,
      '@cf/zai-org/glm-5.2',
      expect.objectContaining({ sessionAffinity: 'gb-opaque' }),
    );
  });

  test('passes a Cloudflare catalog partner slug through Pi provider', () => {
    const creds = { binding: {} as Ai };
    getPiProvider(creds, 'deepseek/deepseek-v4-pro', { sessionAffinity: 'gb-opaque' });
    expect(getPiModel).toHaveBeenCalledWith(
      creds,
      'deepseek/deepseek-v4-pro',
      expect.objectContaining({ sessionAffinity: 'gb-opaque' }),
    );
  });
});
