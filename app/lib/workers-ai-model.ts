import { MAX_ESTIMATED_MODEL_INPUT_TOKENS, MODEL_MAX_OUTPUT_TOKENS } from 'ghostbuild-agent/context-limits';
import { z } from 'zod';

const WORKERS_AI_MODEL_ID_PATTERN = /^@cf\/[a-z0-9][a-z0-9-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type WorkersAiModelId = `@cf/${string}/${string}`;

export type WorkersAiModel = {
  id: WorkersAiModelId;
  label: string;
  description: string;
  contextTokens: number;
  requiresPaid: boolean;
  reasoning: boolean;
  vision: boolean;
};

/** The deliberately pinned default; catalog discovery may add choices but never silently changes it. */
export const CLOUDFLARE_WORKERS_AI_MODEL = '@cf/zai-org/glm-5.3-flash' satisfies WorkersAiModelId;

export const CLOUDFLARE_PROJECT_TITLE_MODEL = '@cf/meta/llama-3.2-1b-instruct' satisfies WorkersAiModelId;

/**
 * Context-compaction summaries must come from a fast, large-context model that never spends its
 * output budget on hidden reasoning: GLM 5.3 Flash produced 24s empty "summaries" (all
 * reasoning_content, finish_reason length), and a failed summary aborts the whole builder turn.
 */
export const CLOUDFLARE_CONTEXT_SUMMARY_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct' satisfies WorkersAiModelId;
export type WorkersAiRuntimeModelId = WorkersAiModelId;

export const MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS = MAX_ESTIMATED_MODEL_INPUT_TOKENS + MODEL_MAX_OUTPUT_TOKENS;

export const DEFAULT_WORKERS_AI_MODEL: WorkersAiModel = {
  id: CLOUDFLARE_WORKERS_AI_MODEL,
  label: 'GLM 5.3 Flash',
  description: 'Latest fast GLM model for coding, reasoning, and tool-driven builds.',
  contextTokens: 1_048_576,
  requiresPaid: true,
  reasoning: true,
  vision: true,
};

/** Safe startup fallback while the connected account's live Workers AI catalog is loading. */
export const WORKERS_AI_MODELS: readonly WorkersAiModel[] = [DEFAULT_WORKERS_AI_MODEL];

export const workersAiModelIdSchema: z.ZodType<WorkersAiModelId> = z
  .templateLiteral(['@cf/', z.string(), '/', z.string()])
  .refine((modelId) => WORKERS_AI_MODEL_ID_PATTERN.test(modelId));

const workersAiModelSchema = z.object({
  id: workersAiModelIdSchema,
  label: z.string().min(1).max(128),
  description: z.string().min(1).max(1_000),
  contextTokens: z.number().int().min(MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS),
  requiresPaid: z.boolean(),
  reasoning: z.boolean(),
  vision: z.boolean(),
});

export const workersAiModelCatalogPayloadSchema = z.object({
  defaultModelId: workersAiModelIdSchema,
  models: z.array(workersAiModelSchema).min(1).max(101),
});

export type WorkersAiModelCatalogPayload = {
  defaultModelId: WorkersAiModelId;
  models: WorkersAiModel[];
};

export function isWorkersAiModelId(value: string | null | undefined): value is WorkersAiModelId {
  return value !== null && value !== undefined && workersAiModelIdSchema.safeParse(value).success;
}

export function validateWorkersAiModelCatalogPayload(
  payload: WorkersAiModelCatalogPayload,
): WorkersAiModelCatalogPayload | null {
  const { defaultModelId, models } = payload;
  if (!models.some(({ id }) => id === defaultModelId) || new Set(models.map(({ id }) => id)).size !== models.length) {
    return null;
  }
  return { defaultModelId, models };
}

export function getWorkersAiModel(
  modelId: WorkersAiModelId,
  models: readonly WorkersAiModel[] = WORKERS_AI_MODELS,
): WorkersAiModel {
  return models.find(({ id }) => id === modelId) ?? DEFAULT_WORKERS_AI_MODEL;
}
