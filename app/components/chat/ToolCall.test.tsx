// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    ['read', 'File read stopped', 'Reading'],
    ['write', 'File write stopped', 'Writing a file'],
    ['edit', 'File edit stopped', 'Editing'],
    ['exec', 'Command stopped', 'Running'],
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

  it('renders an exact Cloudflare proposal and wires its durable approval decision', async () => {
    const invocation: GhostbuildToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'cloudflare-execute-1',
      toolName: 'cloudflare_execute',
      input: { code: 'return await client.deleteZone("zone-1")' },
      output: {
        kind: 'cloudflare_execute_proposal',
        status: 'awaiting_approval',
        executionId: 'execution-1',
        toolCallId: 'cloudflare-execute-1',
        accountId: 'account-1',
        code: 'return await client.deleteZone("zone-1")',
        proposalSha256: 'a'.repeat(64),
        riskNote: 'This may delete an externally visible resource.',
        expiresAt: Date.now() + 60_000,
      },
    };
    const decide = vi.fn(async () => ({
      execution: {
        executionId: 'execution-1',
        toolCallId: 'cloudflare-execute-1',
        accountId: 'account-1',
        proposalSha256: 'a'.repeat(64),
        status: 'succeeded' as const,
        createdAt: Date.now(),
        decidedAt: Date.now(),
        startedAt: Date.now(),
        completedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        outcome: { status: 'success' as const, summary: 'done' },
      },
      resumeTurn: true,
    }));

    await act(async () =>
      root.render(
        <ToolCall
          partId={makePartId('message-1', 0)}
          invocation={invocation}
          cloudflareExecutions={[
            {
              executionId: 'execution-1',
              toolCallId: 'cloudflare-execute-1',
              accountId: 'account-1',
              proposalSha256: 'a'.repeat(64),
              status: 'awaiting_approval',
              createdAt: Date.now(),
              decidedAt: null,
              startedAt: null,
              completedAt: null,
              expiresAt: Date.now() + 60_000,
              outcome: null,
            },
          ]}
          onCloudflareExecutionDecision={decide}
        />,
      ),
    );
    await act(async () => container.querySelector('button')?.click());

    expect(container.textContent).toContain('return await client.deleteZone("zone-1")');
    expect(container.textContent).toContain('Digest: aaaaaaaaaaaa');
    expect(container.textContent).toContain('Account: account-1');
    const approve = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Approve'));
    await act(async () => approve?.click());

    expect(decide).toHaveBeenCalledWith('execution-1', 'approve');
  });

  it('renders an indeterminate Cloudflare execution as terminal reconciliation guidance', async () => {
    const invocation: GhostbuildToolInvocation = {
      type: 'dynamic-tool',
      state: 'output-available',
      toolCallId: 'cloudflare-execute-2',
      toolName: 'cloudflare_execute',
      input: { code: 'return mutate()' },
      output: {
        kind: 'cloudflare_execute_proposal',
        status: 'awaiting_approval',
        executionId: 'execution-2',
        toolCallId: 'cloudflare-execute-2',
        accountId: 'account-1',
        code: 'return mutate()',
        proposalSha256: 'b'.repeat(64),
        riskNote: 'risk',
        expiresAt: Date.now() + 60_000,
      },
    };
    await act(async () =>
      root.render(
        <ToolCall
          partId={makePartId('message-2', 0)}
          invocation={invocation}
          cloudflareExecutions={[
            {
              executionId: 'execution-2',
              toolCallId: 'cloudflare-execute-2',
              accountId: 'account-1',
              proposalSha256: 'b'.repeat(64),
              status: 'indeterminate',
              createdAt: Date.now(),
              decidedAt: Date.now(),
              startedAt: Date.now(),
              completedAt: Date.now(),
              expiresAt: Date.now() + 60_000,
              outcome: { status: 'indeterminate', summary: 'Interrupted; not replayed.' },
            },
          ]}
        />,
      ),
    );
    await act(async () => container.querySelector('button')?.click());

    expect(container.textContent).toContain('Outcome indeterminate');
    expect(container.textContent).toContain('Interrupted; not replayed.');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Approve'))).toBe(
      false,
    );
  });
});
