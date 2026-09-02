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

/**
 * The deliberately pinned default; catalog discovery may add choices but never silently changes
 * it. Default selection requires a successful end-to-end canary build: gpt-oss-120b completed
 * prompt→validated→preview→deployed on 2026-09-02, while glm-5.3-flash failed canary in every
 * tested reasoning configuration (unbounded, medium, and low effort).
 */
export const CLOUDFLARE_WORKERS_AI_MODEL = '@cf/openai/gpt-oss-120b' satisfies WorkersAiModelId;

/**
 * Titles must come from a model that speaks the OpenAI completions response shape, because every
 * Ghostbuild request goes through the Pi `openai-completions` adapter, which reads only
 * `choices[].delta`. Small Workers AI models such as `@cf/meta/llama-3.2-1b-instruct` answer in
 * Cloudflare's native `{ response, usage }` shape instead: the adapter parses no text, the title
 * comes back empty, and every chat silently keeps its heuristic prompt-derived name. Do not move
 * this to a native-shape model. Llama 4 Scout answers in the OpenAI shape, in about half a second,
 * and already backs `CLOUDFLARE_CONTEXT_SUMMARY_MODEL`.
 */
export const CLOUDFLARE_PROJECT_TITLE_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct' satisfies WorkersAiModelId;

/**
 * Context-compaction summaries must come from a fast, large-context model that never spends its
 * output budget on hidden reasoning: GLM 5.3 Flash produced 24s empty "summaries" (all
 * reasoning_content, finish_reason length), and a failed summary aborts the whole builder turn.
 */
export const CLOUDFLARE_CONTEXT_SUMMARY_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct' satisfies WorkersAiModelId;
export type WorkersAiRuntimeModelId = WorkersAiModelId;

/**
 * The smallest context window Ghostbuild will drive a builder model with. An explicit floor, not a
 * derived one: the input budget and the per-request output ceiling both scale with whatever window
 * a model actually has, so this only has to exclude windows too small to hold the system prompt,
 * the tool schemas, and a working transcript at once.
 */
export const MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS = 32_768;

export const DEFAULT_WORKERS_AI_MODEL: WorkersAiModel = {
  id: CLOUDFLARE_WORKERS_AI_MODEL,
  label: 'GPT OSS 120B',
  description: "OpenAI's open-weight model for agentic coding, tool calling, and production builds.",
  contextTokens: 128_000,
  requiresPaid: false,
  reasoning: true,
  vision: false,
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
