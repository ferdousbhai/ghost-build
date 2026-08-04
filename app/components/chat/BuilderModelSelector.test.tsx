// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { builderModelStore } from '~/lib/stores/builder-model.client';
import { BuilderModelSelector } from './BuilderModelSelector.client';

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  builderModelStore.set(CLOUDFLARE_WORKERS_AI_MODEL);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('BuilderModelSelector', () => {
  it('groups hosted and partner models and persists a selection', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<BuilderModelSelector />));

    const select = document.querySelector('select') as unknown as HTMLSelectElement | null;
    expect(select?.getAttribute('aria-label')).toContain('GLM 5.2');
    expect([...document.querySelectorAll('optgroup')].map(({ label }) => label)).toEqual([
      'Cloudflare-hosted',
      'Partner via Cloudflare',
    ]);

    act(() => {
      if (select) {
        select.value = 'deepseek/deepseek-v4-pro';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    expect(builderModelStore.get()).toBe('deepseek/deepseek-v4-pro');
    expect(localStorage.getItem('ghostbuild_builder_model')).toBe('deepseek/deepseek-v4-pro');
  });

  it('prevents changes while a turn is active', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<BuilderModelSelector disabled />));

    const select = document.querySelector('select') as unknown as HTMLSelectElement | null;
    expect(select?.disabled).toBe(true);
  });
});
