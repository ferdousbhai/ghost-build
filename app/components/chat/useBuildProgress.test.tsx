// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_PROGRESS_DELAY_MS, VALIDATION_PROGRESS_DELAY_MS } from './build-progress';
import { useBuildProgress } from './useBuildProgress';

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('useBuildProgress', () => {
  it('starts a fresh progress window when the active build phase changes', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness({ validating }: { validating: boolean }) {
      const progress = useBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        isProjectUpdate: false,
        activeToolNames: validating ? ['write'] : [],
        validationStage: validating ? 'computer validation' : null,
        toolActivityRevision: 1,
        toolProgressRevision: 0,
        messages: [],
      });
      return <span>{progress?.message}</span>;
    }

    await act(async () => root?.render(<Harness validating />));
    await act(async () => vi.advanceTimersByTime(VALIDATION_PROGRESS_DELAY_MS));
    expect(container.textContent).toBe('Still validating your project with cloudflare computer — no new update for 2m');

    await act(async () => root?.render(<Harness validating={false} />));
    expect(container.textContent).toBe('Creating your project…');
  });

  it('resets the quiet timer when streamed command output arrives', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness({ progressRevision }: { progressRevision: number }) {
      const progress = useBuildProgress({
        streamStatus: 'streaming',
        isRecovering: false,
        isProjectUpdate: true,
        activeToolNames: ['exec'],
        validationStage: null,
        toolActivityRevision: 1,
        toolProgressRevision: progressRevision,
        messages: [],
      });
      return <span>{progress?.message}</span>;
    }

    await act(async () => root?.render(<Harness progressRevision={0} />));
    await act(async () => vi.advanceTimersByTime(BUILD_PROGRESS_DELAY_MS));
    expect(container.textContent).toBe('Command is still running — no new output for 45s');

    await act(async () => root?.render(<Harness progressRevision={1} />));
    expect(container.textContent).toBe('Running command…');
  });
});
