import { describe, expect, test } from 'vitest';
import { createWorkersAiSessionAffinity } from './workers-ai-prompt-cache';

describe('Workers AI prompt-cache identity', () => {
  test('uses an opaque stable affinity per transcript generation', async () => {
    const identity = { agentName: 'private-agent-name', subchatIndex: 2, generation: 3 };
    const affinity = await createWorkersAiSessionAffinity(identity, '@cf/zai-org/glm-5.3-flash');

    expect(affinity).toBe(await createWorkersAiSessionAffinity(identity, '@cf/zai-org/glm-5.3-flash'));
    expect(affinity).toMatch(/^gb-[a-f0-9]{64}$/);
    expect(affinity).not.toContain(identity.agentName);
    expect(await createWorkersAiSessionAffinity({ ...identity, generation: 4 }, '@cf/zai-org/glm-5.3-flash')).not.toBe(
      affinity,
    );
    expect(await createWorkersAiSessionAffinity(identity, '@cf/openai/gpt-oss-120b')).not.toBe(affinity);
  });
});
