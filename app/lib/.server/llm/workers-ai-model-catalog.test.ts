import { describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODEL, DEFAULT_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import {
  readWorkersAiBuilderModelCatalog,
  requireWorkersAiBuilderModel,
  WorkersAiModelCatalogUnavailableError,
  workersAiModelCatalogPayload,
} from './workers-ai-model-catalog';

const eligibleProperties = [
  { property_id: 'context_window', value: '131072' },
  { property_id: 'function_calling', value: 'true' },
  { property_id: 'require_workers_paid', value: 'false' },
  { property_id: 'reasoning', value: 'true' },
  { property_id: 'vision', value: 'false' },
];

type ModelOverrides = {
  source?: number;
  properties?: AiModelsSearchObject['properties'];
  taskName?: string;
  createdAt?: string;
};

function model(name: string, overrides: ModelOverrides = {}): AiModelsSearchObject {
  const entry = {
    id: name,
    source: overrides.source ?? 1,
    name,
    description: `Description for ${name}`,
    task: { id: 'text-generation', name: overrides.taskName ?? 'Text Generation', description: 'Text generation' },
    tags: [],
    properties: overrides.properties ?? eligibleProperties,
  };
  // Cloudflare dates every catalog entry; the generated binding type simply does not declare it.
  return overrides.createdAt === undefined ? entry : Object.assign(entry, { created_at: overrides.createdAt });
}

describe('Workers AI live model catalog', () => {
  it('returns native builder-compatible models with normalized metadata', async () => {
    const binding = {
      models: vi.fn(async () => [
        model('@cf/zai-org/glm-5.3-flash', {
          properties: [
            ...eligibleProperties,
            { property_id: 'context_window', value: '1048576' },
            { property_id: 'require_workers_paid', value: 'true' },
            { property_id: 'vision', value: 'true' },
          ],
        }),
        model('@cf/openai/gpt-oss-120b'),
        model('@hf/example/partner'),
        model('@cf/example/no-tools', {
          properties: [{ property_id: 'context_window', value: '131072' }],
        }),
        model('@cf/example/small', {
          properties: [
            // Below MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS: too small to hold the builder's own
            // system prompt and tool schemas alongside a working transcript.
            { property_id: 'context_window', value: '16384' },
            { property_id: 'function_calling', value: 'true' },
          ],
        }),
        model('@cf/example/wrong-source', { source: 2 }),
      ]),
    };

    const models = await readWorkersAiBuilderModelCatalog(binding);

    expect(binding.models).toHaveBeenCalledWith({
      task: 'Text Generation',
      hide_experimental: true,
      page: 1,
      per_page: 100,
    });
    expect(models.map(({ id }) => id)).toEqual(['@cf/zai-org/glm-5.3-flash', '@cf/openai/gpt-oss-120b']);
    expect(models[0]).toMatchObject({
      label: 'GLM 5.3 Flash',
      contextTokens: 1_048_576,
      requiresPaid: true,
      reasoning: true,
      vision: true,
    });
  });

  it('carries the catalog publication date through, and omits an unusable one', async () => {
    const binding = {
      models: vi.fn(async () => [
        model('@cf/openai/gpt-oss-120b', { createdAt: '2026-08-26 00:00:00.000' }),
        model('@cf/example/undated'),
        model('@cf/example/bad-date', { createdAt: 'sometime last week' }),
      ]),
    };

    const models = await readWorkersAiBuilderModelCatalog(binding);

    expect(models[0]?.createdAt).toBe(new Date('2026-08-26 00:00:00.000').toISOString());
    expect(models[1]).not.toHaveProperty('createdAt');
    expect(models[2]).not.toHaveProperty('createdAt');
  });

  it('pins and includes GLM 5.3 Flash even when discovery omits it', () => {
    const otherModel = {
      ...DEFAULT_WORKERS_AI_MODEL,
      id: '@cf/example/other' as const,
      label: 'Other',
    };

    expect(workersAiModelCatalogPayload([otherModel])).toEqual({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      models: [DEFAULT_WORKERS_AI_MODEL, otherModel],
    });
  });

  it('validates non-default selections against the current account catalog', async () => {
    const selected = model('@cf/openai/gpt-oss-120b');
    const binding = { models: vi.fn(async () => [selected]) };

    await expect(requireWorkersAiBuilderModel(binding, '@cf/openai/gpt-oss-120b')).resolves.toMatchObject({
      id: '@cf/openai/gpt-oss-120b',
    });
    await expect(requireWorkersAiBuilderModel(binding, '@cf/example/missing')).rejects.toMatchObject({ status: 400 });
  });

  it('keeps the pinned default available when catalog discovery is down', async () => {
    const binding = { models: vi.fn(async () => Promise.reject(new Error('down'))) };

    await expect(requireWorkersAiBuilderModel(binding, CLOUDFLARE_WORKERS_AI_MODEL)).resolves.toBe(
      DEFAULT_WORKERS_AI_MODEL,
    );
    await expect(readWorkersAiBuilderModelCatalog(binding)).rejects.toBeInstanceOf(
      WorkersAiModelCatalogUnavailableError,
    );
  });
});
