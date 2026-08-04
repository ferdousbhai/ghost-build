import { describe, expect, test } from 'vitest';
import { createWorkersAiSessionAffinity, fingerprintWorkersAiModelInput } from './workers-ai-prompt-cache';

describe('Workers AI prompt-cache identity', () => {
  test('uses an opaque stable affinity per transcript generation', async () => {
    const identity = { agentName: 'private-agent-name', subchatIndex: 2, generation: 3 };
    const affinity = await createWorkersAiSessionAffinity(identity);

    expect(affinity).toBe(await createWorkersAiSessionAffinity(identity));
    expect(affinity).toMatch(/^gb-[a-f0-9]{64}$/);
    expect(affinity).not.toContain(identity.agentName);
    expect(await createWorkersAiSessionAffinity({ ...identity, generation: 4 })).not.toBe(affinity);
  });

  test('invalidates the privacy-safe fingerprint for every model-visible cache boundary', async () => {
    const base = {
      privacySalt: 'opaque-session-affinity',
      model: '@cf/zai-org/glm-5.2',
      instructions: 'stable',
      messages: [{ role: 'user', content: 'project instructions A' }],
      tools: { read: { description: 'read' } },
      activeTools: ['read'],
      toolChoice: 'auto',
    };
    const fingerprint = await fingerprintWorkersAiModelInput(base);

    await expect(fingerprintWorkersAiModelInput(base)).resolves.toBe(fingerprint);
    await expect(
      fingerprintWorkersAiModelInput({ ...base, privacySalt: 'different-transcript-generation' }),
    ).resolves.not.toBe(fingerprint);

    await expect(fingerprintWorkersAiModelInput({ ...base, model: '@cf/zai-org/glm-next' })).resolves.not.toBe(
      fingerprint,
    );
    await expect(fingerprintWorkersAiModelInput({ ...base, instructions: 'changed prompt' })).resolves.not.toBe(
      fingerprint,
    );
    await expect(
      fingerprintWorkersAiModelInput({ ...base, tools: { read: { description: 'changed schema' } } }),
    ).resolves.not.toBe(fingerprint);
    await expect(
      fingerprintWorkersAiModelInput({
        ...base,
        messages: [{ role: 'user', content: 'project instructions B' }],
      }),
    ).resolves.not.toBe(fingerprint);
    await expect(fingerprintWorkersAiModelInput({ ...base, activeTools: [] })).resolves.not.toBe(fingerprint);
    await expect(fingerprintWorkersAiModelInput({ ...base, toolChoice: 'required' })).resolves.not.toBe(fingerprint);
  });
});
