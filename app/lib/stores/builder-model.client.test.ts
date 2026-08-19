// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODEL, PREFERRED_BUILDER_MODEL } from '~/lib/workers-ai-model';
import {
  builderDefaultModelStore,
  builderModelDeniedByCreditsStore,
  builderModelStore,
  initializeBuilderModelPreference,
  loadBuilderModelPreference,
  setBuilderModel,
  syncBuilderModelPreference,
} from './builder-model.client';

describe('builder model preference', () => {
  beforeEach(() => initializeBuilderModelPreference('unknown', { getItem: () => null }));

  it('loads an allowlisted preference and defaults invalid values', () => {
    loadBuilderModelPreference({ getItem: () => '@cf/zai-org/glm-5.2' });
    expect(builderModelStore.get()).toBe('@cf/zai-org/glm-5.2');

    loadBuilderModelPreference({ getItem: () => '@cf/example/retired' });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });

  it('uses DeepSeek by default when AI Gateway Unified Billing credits are available', () => {
    initializeBuilderModelPreference('available', { getItem: () => null });

    expect(builderModelStore.get()).toBe(PREFERRED_BUILDER_MODEL);
    expect(builderDefaultModelStore.get()).toBe(PREFERRED_BUILDER_MODEL);
  });

  it.each(['unavailable', 'unknown'] as const)('uses the hosted fallback when credit status is %s', (creditStatus) => {
    initializeBuilderModelPreference(creditStatus, { getItem: () => PREFERRED_BUILDER_MODEL });

    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    expect(builderDefaultModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });

  it('preserves an explicit hosted-model preference when credits are available', () => {
    initializeBuilderModelPreference('available', { getItem: () => '@cf/zai-org/glm-5.2' });

    expect(builderModelStore.get()).toBe('@cf/zai-org/glm-5.2');
  });

  it('keeps the in-memory choice when local storage is unavailable', () => {
    const setItem = vi.fn(() => {
      throw new DOMException('Blocked');
    });

    setBuilderModel('@cf/zai-org/glm-5.2', { setItem });

    expect(builderModelStore.get()).toBe('@cf/zai-org/glm-5.2');
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

describe('credit denial', () => {
  it('says a saved choice was overridden only when credits are confirmed absent', () => {
    initializeBuilderModelPreference('unavailable', { getItem: () => PREFERRED_BUILDER_MODEL });
    expect(builderModelDeniedByCreditsStore.get()).toBe(true);
  });

  it('stays quiet while credit status is still unknown, because the choice is re-evaluated', () => {
    // The preference is downgraded here too, but announcing a denial before the runtime
    // session resolves would be guessing at a reason.
    initializeBuilderModelPreference('unknown', { getItem: () => PREFERRED_BUILDER_MODEL });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    expect(builderModelDeniedByCreditsStore.get()).toBe(false);
  });

  it('stays quiet when the saved choice needs no credits', () => {
    initializeBuilderModelPreference('unavailable', { getItem: () => CLOUDFLARE_WORKERS_AI_MODEL });
    expect(builderModelDeniedByCreditsStore.get()).toBe(false);
  });
});
