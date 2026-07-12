import { describe, expect, test, vi } from 'vitest';
import { summarizeBuilderContext } from './workers-ai-text';

describe('summarizeBuilderContext', () => {
  test('returns a trimmed readable summary', async () => {
    const run = vi.fn().mockResolvedValue({ response: '  current state  ' });
    const env = { AI: { run } } as unknown as Env;

    await expect(summarizeBuilderContext(env, 'conversation')).resolves.toBe('current state');
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).not.toHaveProperty('response_format');
  });

  test('uses a fixed safe error when generation fails', async () => {
    const env = { AI: { run: vi.fn().mockResolvedValue({}) } } as unknown as Env;
    await expect(summarizeBuilderContext(env, 'conversation')).rejects.toThrow('Context compaction generation failed.');
  });
});
