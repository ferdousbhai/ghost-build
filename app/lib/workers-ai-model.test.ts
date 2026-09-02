import { describe, expect, it } from 'vitest';
import { MAX_ESTIMATED_MODEL_INPUT_TOKENS, MODEL_MAX_OUTPUT_TOKENS } from 'ghostbuild-agent/context-limits';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  getWorkersAiModel,
  isWorkersAiModelId,
  validateWorkersAiModelCatalogPayload,
  WORKERS_AI_MODELS,
  workersAiModelCatalogPayloadSchema,
  type WorkersAiModel,
} from './workers-ai-model';

const alternativeModel: WorkersAiModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/zai-org/glm-5.3-flash',
  label: 'GLM 5.3 Flash',
  contextTokens: 1_048_576,
  requiresPaid: true,
  vision: true,
};

describe('Workers AI model catalog', () => {
  it('pins the canary-proven GPT OSS 120B as the safe startup default', () => {
    expect(CLOUDFLARE_WORKERS_AI_MODEL).toBe('@cf/openai/gpt-oss-120b');
    expect(WORKERS_AI_MODELS).toEqual([DEFAULT_WORKERS_AI_MODEL]);
    expect(DEFAULT_WORKERS_AI_MODEL.contextTokens).toBeGreaterThanOrEqual(
      MAX_ESTIMATED_MODEL_INPUT_TOKENS + MODEL_MAX_OUTPUT_TOKENS,
    );
    expect(DEFAULT_WORKERS_AI_MODEL.contextTokens).toBe(128_000);
    expect(getWorkersAiModel(CLOUDFLARE_WORKERS_AI_MODEL)).toBe(DEFAULT_WORKERS_AI_MODEL);
  });

  it('accepts Cloudflare-native model slugs without pretending they are catalog membership', () => {
    expect(isWorkersAiModelId('@cf/zai-org/glm-5.3-flash')).toBe(true);
    expect(isWorkersAiModelId('@cf/openai/gpt-oss-120b')).toBe(true);
    expect(isWorkersAiModelId('deepseek/deepseek-v4-pro')).toBe(false);
    expect(isWorkersAiModelId('@cf/example')).toBe(false);
    expect(isWorkersAiModelId(undefined)).toBe(false);
  });

  it('parses a unique catalog whose declared default is present', () => {
    const payload = {
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      models: [DEFAULT_WORKERS_AI_MODEL, alternativeModel],
    };

    const parsed = workersAiModelCatalogPayloadSchema.safeParse(payload);
    expect(parsed.success && validateWorkersAiModelCatalogPayload(parsed.data)).toEqual(payload);
    expect(getWorkersAiModel(alternativeModel.id, payload.models)).toEqual(alternativeModel);
    const missingDefault = workersAiModelCatalogPayloadSchema.parse({
      ...payload,
      defaultModelId: '@cf/example/missing',
    });
    expect(validateWorkersAiModelCatalogPayload(missingDefault)).toBeNull();
    const duplicate = workersAiModelCatalogPayloadSchema.parse({
      ...payload,
      models: [alternativeModel, alternativeModel],
    });
    expect(validateWorkersAiModelCatalogPayload(duplicate)).toBeNull();
  });
});
