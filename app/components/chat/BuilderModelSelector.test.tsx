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

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    expect(trigger?.getAttribute('aria-label')).toContain('GLM 5.2');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });

    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Cloudflare hosted');
    expect(menu?.textContent).toContain('Partner via Cloudflare');
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(6);
    const deepSeek = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.includes('DeepSeek V4 Pro'),
    );

    await act(async () => deepSeek?.click());

    expect(builderModelStore.get()).toBe('deepseek/deepseek-v4-pro');
    expect(localStorage.getItem('ghostbuild_builder_model')).toBe('deepseek/deepseek-v4-pro');
  });

  it('closes the menu and prevents changes when a turn becomes active', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<BuilderModelSelector />));

    const enabledTrigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    await act(async () => {
      enabledTrigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => root?.render(<BuilderModelSelector disabled />));

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    expect(trigger?.disabled).toBe(true);
    expect(trigger?.title).toContain('Stop or wait');
    expect(trigger?.getAttribute('aria-label')).toContain('before switching models');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });
});
