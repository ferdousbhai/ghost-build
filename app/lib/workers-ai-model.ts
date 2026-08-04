export const WORKERS_AI_MODELS = [
  {
    id: '@cf/zai-org/glm-5.2',
    label: 'GLM 5.2',
    description: 'Best for complex coding and agentic builds.',
    availability: 'cloudflare-hosted',
    contextTokens: 262_144,
  },
  {
    id: '@cf/moonshotai/kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    description: 'Coding, long context, and visual reasoning.',
    availability: 'cloudflare-hosted',
    contextTokens: 262_144,
  },
  {
    id: '@cf/openai/gpt-oss-120b',
    label: 'GPT-OSS 120B',
    description: 'Strong general reasoning at lower cost.',
    availability: 'cloudflare-hosted',
    contextTokens: 128_000,
  },
  {
    id: '@cf/google/gemma-4-26b-a4b-it',
    label: 'Gemma 4',
    description: 'Fast, low-cost multimodal reasoning.',
    availability: 'cloudflare-hosted',
    contextTokens: 256_000,
  },
  {
    id: '@cf/zai-org/glm-4.7-flash',
    label: 'GLM 4.7 Flash',
    description: 'Fastest option for smaller changes.',
    availability: 'cloudflare-hosted',
    contextTokens: 131_072,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'Experimental partner model served by Fireworks through Cloudflare.',
    availability: 'cloudflare-partner',
    contextTokens: 131_072,
  },
] as const;

export type WorkersAiModel = (typeof WORKERS_AI_MODELS)[number];
export type WorkersAiModelId = WorkersAiModel['id'];

export const CLOUDFLARE_WORKERS_AI_MODEL = WORKERS_AI_MODELS[0].id;
export const CLOUDFLARE_PROJECT_TITLE_MODEL = '@cf/meta/llama-3.2-1b-instruct';

const WORKERS_AI_MODEL_IDS = new Set<string>(WORKERS_AI_MODELS.map(({ id }) => id));

export function isWorkersAiModelId(value: unknown): value is WorkersAiModelId {
  return typeof value === 'string' && WORKERS_AI_MODEL_IDS.has(value);
}

export function getWorkersAiModel(modelId: WorkersAiModelId): WorkersAiModel {
  return WORKERS_AI_MODELS.find(({ id }) => id === modelId) ?? WORKERS_AI_MODELS[0];
}
