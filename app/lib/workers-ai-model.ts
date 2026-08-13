export const WORKERS_AI_MODELS = [
  {
    id: '@cf/zai-org/glm-5.2',
    label: 'GLM 5.2',
    description: 'Best for complex coding and agentic builds.',
    availability: 'cloudflare-hosted',
    contextTokens: 262_144,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'Third-party model served by Fireworks; uses AI Gateway Unified Billing credits.',
    availability: 'cloudflare-partner',
    contextTokens: 131_072,
  },
] as const;

export type WorkersAiModel = (typeof WORKERS_AI_MODELS)[number];
export type WorkersAiModelId = WorkersAiModel['id'];

export const CLOUDFLARE_WORKERS_AI_MODEL = WORKERS_AI_MODELS[0].id;
export const PREFERRED_BUILDER_MODEL = 'deepseek/deepseek-v4-pro' satisfies WorkersAiModelId;
export const CLOUDFLARE_PROJECT_TITLE_MODEL = '@cf/meta/llama-3.2-1b-instruct';
export type WorkersAiRuntimeModelId = WorkersAiModelId | typeof CLOUDFLARE_PROJECT_TITLE_MODEL;

const WORKERS_AI_MODEL_IDS = new Set<string>(WORKERS_AI_MODELS.map(({ id }) => id));

export function isWorkersAiModelId(value: unknown): value is WorkersAiModelId {
  return typeof value === 'string' && WORKERS_AI_MODEL_IDS.has(value);
}

export function getWorkersAiModel(modelId: WorkersAiModelId): WorkersAiModel {
  return WORKERS_AI_MODELS.find(({ id }) => id === modelId) ?? WORKERS_AI_MODELS[0];
}
