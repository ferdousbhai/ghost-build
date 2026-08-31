import { beforeEach, describe, expect, test, vi } from 'vitest';

const getPiModel = vi.hoisted(() => vi.fn(() => ({ model: { id: 'workers-ai-model' }, stream: vi.fn() })));
vi.mock('./pi-ai-models', () => ({ getPiModel }));

import { getPiProvider } from './provider';
import { DEFAULT_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';

describe('Workers AI provider (Pi)', () => {
  beforeEach(() => vi.clearAllMocks());

  test('uses the user-runtime binding with Pi ModelHandle', () => {
    const credentials = { binding: {} as Ai };
    getPiProvider(credentials, DEFAULT_WORKERS_AI_MODEL.id, {
      model: DEFAULT_WORKERS_AI_MODEL,
      sessionAffinity: 'gb-opaque',
    });

    expect(getPiModel).toHaveBeenCalledWith(
      credentials,
      DEFAULT_WORKERS_AI_MODEL.id,
      expect.objectContaining({ model: DEFAULT_WORKERS_AI_MODEL, sessionAffinity: 'gb-opaque' }),
    );
  });

  test('passes a discovered Cloudflare model through Pi provider', () => {
    const creds = { binding: {} as Ai };
    const model = { ...DEFAULT_WORKERS_AI_MODEL, id: '@cf/openai/gpt-oss-120b' as const, label: 'GPT OSS 120B' };
    getPiProvider(creds, model.id, { model, sessionAffinity: 'gb-opaque' });
    expect(getPiModel).toHaveBeenCalledWith(
      creds,
      model.id,
      expect.objectContaining({ model, sessionAffinity: 'gb-opaque' }),
    );
  });
});
