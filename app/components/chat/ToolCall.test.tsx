// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { makePartId } from 'ghostbuild-agent/partId';
import { toolSuccess } from 'ghostbuild-agent/tool-result';
import { ToolCall } from './ToolCall';

describe('ToolCall', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
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
