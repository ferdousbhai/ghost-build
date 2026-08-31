import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  isWorkersAiModelId,
  MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS,
  type WorkersAiModel,
  type WorkersAiModelCatalogPayload,
  type WorkersAiModelId,
} from '~/lib/workers-ai-model';

const MAX_CATALOG_MODELS = 100;

type WorkersAiCatalogBinding = Pick<Ai, 'models'>;

export class WorkersAiModelCatalogUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('The Cloudflare Workers AI model catalog is temporarily unavailable.', { cause });
    this.name = 'WorkersAiModelCatalogUnavailableError';
  }
}

/** Read the current account-visible catalog through its AI binding, never control-plane credentials. */
export async function readWorkersAiBuilderModelCatalog(binding: WorkersAiCatalogBinding): Promise<WorkersAiModel[]> {
  let catalog: AiModelsSearchObject[];
  try {
    catalog = await binding.models({
      task: 'Text Generation',
      hide_experimental: true,
      page: 1,
      per_page: MAX_CATALOG_MODELS,
    });
  } catch (error) {
    throw new WorkersAiModelCatalogUnavailableError(error);
  }

  const models = new Map<WorkersAiModelId, WorkersAiModel>();
  for (const entry of catalog) {
    const properties = new Map(entry.properties.map(({ property_id, value }) => [property_id, value]));
    const contextTokens = numericProperty(properties.get('context_window'));
    if (
      entry.source !== 1 ||
      entry.task.name !== 'Text Generation' ||
      !isWorkersAiModelId(entry.name) ||
      properties.get('function_calling') !== 'true' ||
      contextTokens < MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS
    ) {
      continue;
    }
    models.set(entry.name, {
      id: entry.name,
      label: workersAiModelLabel(entry.name),
      description: boundedDescription(entry.description),
      contextTokens,
      requiresPaid: properties.get('require_workers_paid') === 'true',
      reasoning: properties.get('reasoning') === 'true',
      vision: properties.get('vision') === 'true',
    });
  }
  return [...models.values()];
}

export async function requireWorkersAiBuilderModel(
  binding: WorkersAiCatalogBinding,
  modelId: WorkersAiModelId,
): Promise<WorkersAiModel> {
  // Keep the normal path independent from catalog availability. This pinned model was reviewed with
  // Ghostbuild's tool protocol and remains the safe fallback when discovery itself is unavailable.
  if (modelId === CLOUDFLARE_WORKERS_AI_MODEL) {
    return DEFAULT_WORKERS_AI_MODEL;
  }
  const model = (await readWorkersAiBuilderModelCatalog(binding)).find(({ id }) => id === modelId);
  if (!model) {
    throw new Response('The selected Workers AI model is not compatible with the Ghostbuild builder.', {
      status: 400,
    });
  }
  return model;
}

export function workersAiModelCatalogPayload(models: WorkersAiModel[]): WorkersAiModelCatalogPayload {
  return {
    defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
    models: [DEFAULT_WORKERS_AI_MODEL, ...models.filter(({ id }) => id !== CLOUDFLARE_WORKERS_AI_MODEL)],
  };
}

function numericProperty(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function boundedDescription(value: string): string {
  const description = value.replace(/\s+/g, ' ').trim().slice(0, 1_000);
  return description || 'Cloudflare-hosted model with function calling support.';
}

function workersAiModelLabel(modelId: WorkersAiModelId): string {
  if (modelId === CLOUDFLARE_WORKERS_AI_MODEL) {
    return DEFAULT_WORKERS_AI_MODEL.label;
  }
  return modelId
    .slice(modelId.lastIndexOf('/') + 1)
    .split('-')
    .map((part) => (/^\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
    .replace(/\bGlm\b/g, 'GLM')
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bOss\b/g, 'OSS')
    .replace(/\bFp8\b/g, 'FP8');
}
