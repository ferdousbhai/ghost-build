// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import {
  builderModelStore,
  loadBuilderModelPreference,
  setBuilderModel,
  syncBuilderModelPreference,
} from './builder-model.client';

describe('builder model preference', () => {
  beforeEach(() => builderModelStore.set(CLOUDFLARE_WORKERS_AI_MODEL));

  it('loads an allowlisted preference and defaults invalid values', () => {
    loadBuilderModelPreference({ getItem: () => '@cf/openai/gpt-oss-120b' });
    expect(builderModelStore.get()).toBe('@cf/openai/gpt-oss-120b');

    loadBuilderModelPreference({ getItem: () => '@cf/example/retired' });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });

  it('keeps the in-memory choice when local storage is unavailable', () => {
    const setItem = vi.fn(() => {
      throw new DOMException('Blocked');
    });

    setBuilderModel('@cf/zai-org/glm-4.7-flash', { setItem });

    expect(builderModelStore.get()).toBe('@cf/zai-org/glm-4.7-flash');
    expect(setItem).toHaveBeenCalledOnce();
  });

  it('synchronizes valid cross-tab changes and ignores unrelated keys', () => {
    syncBuilderModelPreference({ key: 'other', newValue: '@cf/openai/gpt-oss-120b' });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);

    syncBuilderModelPreference({ key: 'ghostbuild_builder_model', newValue: 'deepseek/deepseek-v4-pro' });
    expect(builderModelStore.get()).toBe('deepseek/deepseek-v4-pro');

    syncBuilderModelPreference({ key: 'ghostbuild_builder_model', newValue: null });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });
});
