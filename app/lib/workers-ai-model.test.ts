import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  getWorkersAiModel,
  isWorkersAiModelId,
  WORKERS_AI_MODELS,
} from './workers-ai-model';
import { MAX_ESTIMATED_MODEL_INPUT_TOKENS, MODEL_MAX_OUTPUT_TOKENS } from 'ghostbuild-agent/context-limits';

describe('Workers AI model catalog', () => {
  it('has unique IDs and a valid default', () => {
    const ids = WORKERS_AI_MODELS.map(({ id }) => id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(isWorkersAiModelId(CLOUDFLARE_WORKERS_AI_MODEL)).toBe(true);
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

  it('rejects arbitrary or retired model IDs', () => {
    expect(isWorkersAiModelId('@cf/example/arbitrary')).toBe(false);
    expect(isWorkersAiModelId(undefined)).toBe(false);
  });
});
