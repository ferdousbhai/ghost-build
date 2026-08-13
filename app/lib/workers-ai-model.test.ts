import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  getWorkersAiModel,
  isWorkersAiModelId,
  PREFERRED_BUILDER_MODEL,
  WORKERS_AI_MODELS,
} from './workers-ai-model';
import { MAX_ESTIMATED_MODEL_INPUT_TOKENS, MODEL_MAX_OUTPUT_TOKENS } from 'ghostbuild-agent/context-limits';

describe('Workers AI model catalog', () => {
  it('has unique IDs and a valid default', () => {
    const ids = WORKERS_AI_MODELS.map(({ id }) => id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(isWorkersAiModelId(CLOUDFLARE_WORKERS_AI_MODEL)).toBe(true);
    expect(isWorkersAiModelId(PREFERRED_BUILDER_MODEL)).toBe(true);
  });

  it('keeps every user-facing option accessible and explicit about availability', () => {
    for (const model of WORKERS_AI_MODELS) {
      expect(model.label).not.toHaveLength(0);
      expect(model.description).not.toHaveLength(0);
      expect(['cloudflare-hosted', 'cloudflare-partner']).toContain(model.availability);
      expect(model.contextTokens).toBeGreaterThanOrEqual(MAX_ESTIMATED_MODEL_INPUT_TOKENS + MODEL_MAX_OUTPUT_TOKENS);
      expect(getWorkersAiModel(model.id)).toBe(model);
    }
  });

  it('exposes only GLM 5.2 and paid DeepSeek', () => {
    expect(WORKERS_AI_MODELS.map(({ id }) => id)).toEqual(['@cf/zai-org/glm-5.2', 'deepseek/deepseek-v4-pro']);
    for (const retired of [
      '@cf/moonshotai/kimi-k2.7-code',
      '@cf/openai/gpt-oss-120b',
      '@cf/google/gemma-4-26b-a4b-it',
      '@cf/zai-org/glm-4.7-flash',
      '@cf/example/arbitrary',
    ]) {
      expect(isWorkersAiModelId(retired)).toBe(false);
    }
    expect(isWorkersAiModelId(undefined)).toBe(false);
  });
});
