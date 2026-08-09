// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { makePartId } from 'ghostbuild-agent/partId';
import { toolSuccess } from 'ghostbuild-agent/tool-result';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { toolProgressStore } from '~/lib/stores/tool-progress.client';
import { ToolCall } from './ToolCall';

describe('ToolCall', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.scrollTo = () => undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    toolActivityStore.activities.set({});
    toolActivityStore.startTurn();
    toolProgressStore.clear();
  });

  it.each([
    ['validateProject', 'Project validation stopped', 'Validating the project'],
    ['npmInstall', 'Dependency install stopped', 'Installing dependencies'],
    ['deploy', 'Deployment stopped', 'Checking the project'],
    ['write', 'File write stopped', 'Writing a file'],
  ])('presents an incomplete %s tool from an inactive turn as stopped', async (toolName, stopped, active) => {
    const partId = makePartId('message-1', 0);
    const invocation: GhostbuildToolInvocation = {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'validate-1',
      toolName,
      input: {},
    };
    toolActivityStore.abortActive();
    toolActivityStore.record(partId, invocation);

    await act(async () => root.render(<ToolCall partId={partId} invocation={invocation} />));

    expect(container.textContent).toContain(stopped);
    expect(container.textContent).not.toContain(active);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('shows streamed command arguments and output while execution is active', async () => {
    const invocation: GhostbuildToolInvocation = {
      type: 'dynamic-tool',
      state: 'input-available',
      toolCallId: 'exec-1',
      toolName: 'exec',
      input: { command: 'pnpm test' },
    };
    toolProgressStore.record({
      toolCallId: 'exec-1',
      toolName: 'exec',
      result: { details: { stdout: 'building\n', running: true } },
    });

    await act(async () => root.render(<ToolCall partId={makePartId('message-1', 0)} invocation={invocation} />));

    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Running pnpm test');
    expect(container.textContent).toContain('$ pnpm test');
    expect(container.textContent).toContain('building');
  });

  it('expands valid tool-result markup through its single header control', async () => {
    const invocation: GhostbuildToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'read-1',
      toolName: 'read',
      input: { path: '/home/project/src/index.ts' },
      output: toolSuccess('Read src/index.ts'),
    };

    await act(async () => root.render(<ToolCall partId={makePartId('message-1', 0)} invocation={invocation} />));
    const toggle = container.querySelector('button');

    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle?.click());

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.tool-details')).not.toBeNull();
    expect(container.querySelector('ul')).toBeNull();
  });
});
