// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  type WorkersAiModel,
  type WorkersAiModelCatalogPayload,
} from '~/lib/workers-ai-model';
import {
  builderDefaultModelStore,
  builderModelCatalogStatusStore,
  builderModelsStore,
  builderModelStore,
  initializeBuilderModelPreference,
  installBuilderModelCatalog,
  loadBuilderModelCatalog,
  loadBuilderModelPreference,
} from './builder-model.client';

const alternativeModel: WorkersAiModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/openai/gpt-oss-120b',
  label: 'GPT OSS 120B',
  vision: false,
};
const catalog: WorkersAiModelCatalogPayload = {
  defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
  models: [DEFAULT_WORKERS_AI_MODEL, alternativeModel],
};

describe('builder model preference', () => {
  beforeEach(() => {
    installBuilderModelCatalog(
      { defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL, models: [DEFAULT_WORKERS_AI_MODEL] },
      { getItem: () => null },
    );
    builderModelCatalogStatusStore.set('idle');
  });

  it('uses the pinned GLM 5.3 Flash default before discovery', () => {
    initializeBuilderModelPreference({ getItem: () => null });

    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    expect(builderDefaultModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    expect(builderModelsStore.get()).toEqual([DEFAULT_WORKERS_AI_MODEL]);
  });

  it('installs the live catalog and restores only a current member', () => {
    installBuilderModelCatalog(catalog, { getItem: () => alternativeModel.id });
    expect(builderModelStore.get()).toBe(alternativeModel.id);

    loadBuilderModelPreference({ getItem: () => '@cf/example/retired' });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });

  it('loads and validates the authenticated runtime catalog', async () => {
    const request = vi.fn(async () => Response.json(catalog));

    await loadBuilderModelCatalog(request, { getItem: () => alternativeModel.id });

    expect(request).toHaveBeenCalledWith('/v1/models', { headers: { Accept: 'application/json' } });
    expect(builderModelCatalogStatusStore.get()).toBe('ready');
    expect(builderModelsStore.get()).toEqual(catalog.models);
    expect(builderModelStore.get()).toBe(alternativeModel.id);
  });

  it('keeps the safe fallback when discovery fails', async () => {
    await loadBuilderModelCatalog(async () => new Response(null, { status: 503 }));

    expect(builderModelCatalogStatusStore.get()).toBe('error');
    expect(builderModelsStore.get()).toEqual([DEFAULT_WORKERS_AI_MODEL]);
  });
});
