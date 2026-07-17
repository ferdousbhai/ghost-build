import { generateText } from 'ai';
import { describe, expect, test, vi } from 'vitest';
import { getProvider } from './provider';

describe('Workers AI provider', () => {
  test('forwards opaque session affinity through the binding', async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const env = { AI: { run } } as unknown as Env;
    const provider = getProvider(env, undefined, '@cf/zai-org/glm-5.2', { sessionAffinity: 'gb-opaque' });

    await generateText({ model: provider.model, prompt: 'hello' });

    expect(run.mock.calls[0]?.[2]).toMatchObject({
      extraHeaders: { 'x-session-affinity': 'gb-opaque' },
    });
  });
});
