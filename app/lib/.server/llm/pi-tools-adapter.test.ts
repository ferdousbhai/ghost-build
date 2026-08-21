import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_TOOL_INPUT_SCHEMAS } from 'ghostbuild-agent/model-tool-inputs';
import type { Tool } from 'ghostbuild-agent/tool';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  createWorkersAiTools: vi.fn(),
  /** The mocked module's tool list and the stub tools it returns have to name the same tools. */
  toolNames: ['read', 'ls', 'grep', 'write', 'edit', 'exec', 'search_cloudflare_docs'] as const,
}));

vi.mock('./workers-ai-tools', () => ({
  createWorkersAiTools: mocks.createWorkersAiTools,
  MODEL_TOOL_NAMES: mocks.toolNames,
}));

import { BUILDER_TURN_TIMEOUTS, BuilderTurnBudgetExceededError } from './builder-turn-budget';
import { createPiToolBundle, piToolsToList } from './pi-tools-adapter';

describe('Pi tool adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ ok: true, summary: 'done' });
    mocks.createWorkersAiTools.mockReturnValue(
      Object.fromEntries(
        mocks.toolNames.map((name) => [
          name,
          {
            description: `${name} description`,
            inputSchema: MODEL_TOOL_INPUT_SCHEMAS[name],
            execute: mocks.execute,
          } satisfies Tool,
        ]),
      ),
    );
  });

  it('delegates execution to the canonical wrapped tool', async () => {
    const tools = createPiToolBundle({} as never, operationContext());
    const signal = new AbortController().signal;

    await tools.write.execute('write-1', { path: '/home/project/src/app.ts', content: 'export {};' }, signal);

    expect(mocks.execute).toHaveBeenCalledWith(
      { path: '/home/project/src/app.ts', content: 'export {};' },
      { toolCallId: 'write-1', abortSignal: expect.any(AbortSignal), onUpdate: undefined },
    );
  });

  it.each([
    ['read', { path: '/home/project/src/app.ts' }],
    ['ls', { recursive: true }],
    ['grep', { pattern: 'createRouter' }],
    ['write', { path: '/home/project/src/app.ts', content: 'export {};' }],
    [
      'edit',
      {
        path: '/home/project/src/app.ts',
        base: 'A'.repeat(24),
        edits: [{ startLine: 1, endLine: 1, content: 'changed' }],
      },
    ],
    ['exec', { command: 'pnpm test' }],
  ] as const)('enforces the %s deadline with the typed builder timeout error', async (name, input) => {
    vi.useFakeTimers();
    try {
      let executionSignal: AbortSignal | undefined;
      mocks.execute.mockImplementationOnce(
        async (_input, options) =>
          new Promise((_resolve, reject) => {
            executionSignal = options.abortSignal;
            executionSignal?.addEventListener('abort', () => reject(executionSignal?.reason), { once: true });
          }),
      );
      const tools = createPiToolBundle({} as never, operationContext());
      let rejection: unknown;
      const execution = tools[name].execute(`${name}-timeout`, input).catch((error) => {
        rejection = error;
      });
      const timeoutMs = BUILDER_TURN_TIMEOUTS.tools[name];

      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(rejection).toBeUndefined();
      expect(executionSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await execution;
      expect(rejection).toBeInstanceOf(BuilderTurnBudgetExceededError);
      expect(rejection).toMatchObject({ reason: 'tool_timeout' });
      expect(executionSignal?.reason).toBe(rejection);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves an indeterminate settlement failure discovered after the tool timeout', async () => {
    vi.useFakeTimers();
    try {
      const indeterminate = Object.assign(new Error('workspace outcome is indeterminate'), {
        code: 'workspace_tool_operation_indeterminate',
      });
      mocks.execute.mockImplementationOnce(
        async (_input, options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener('abort', () => reject(indeterminate), { once: true });
          }),
      );
      const tools = createPiToolBundle({} as never, operationContext());
      const execution = tools.write.execute('write-indeterminate', {
        path: '/home/project/src/app.ts',
        content: 'changed',
      });
      const rejection = expect(execution).rejects.toBe(indeterminate);

      await vi.advanceTimersByTimeAsync(BUILDER_TURN_TIMEOUTS.tools.write);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards canonical progress through Pi partial tool results', async () => {
    mocks.execute.mockImplementationOnce(async (_input, options) => {
      options.onUpdate?.({ stdout: 'building\n', running: true });
      return { exitCode: 0, stdout: 'done\n', stderr: '' };
    });
    const tools = createPiToolBundle({} as never, operationContext());
    const onUpdate = vi.fn();

    await tools.exec.execute('exec-1', { command: 'pnpm test' }, undefined, onUpdate);

    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: 'text', text: JSON.stringify({ stdout: 'building\n', running: true }) }],
      details: { stdout: 'building\n', running: true },
    });
  });

  it('rejects invalid Zod input before canonical execution', async () => {
    const tools = createPiToolBundle({} as never, operationContext());

    await expect(tools.write.execute('write-invalid', { path: '/home/project/src/app.ts' })).rejects.toThrow(
      'Invalid tool input for "write"',
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('publishes the curated labels, schemas, and exact tool order', () => {
    const tools = createPiToolBundle({} as never, operationContext());

    expect(piToolsToList(tools).map(({ name, label }) => ({ name, label }))).toEqual([
      { name: 'read', label: 'Read file' },
      { name: 'ls', label: 'List files' },
      { name: 'grep', label: 'Search files' },
      { name: 'write', label: 'Write file' },
      { name: 'edit', label: 'Edit file' },
      { name: 'exec', label: 'Run command' },
      { name: 'search_cloudflare_docs', label: 'Search Cloudflare docs' },
    ]);
    expect(Object.keys((tools.edit.parameters as { properties: object }).properties)).toEqual([
      'path',
      'base',
      'edits',
    ]);
    expect(Object.keys((tools.exec.parameters as { properties: object }).properties)).toEqual(['command', 'cwd']);
    expect(Object.keys((tools.ls.parameters as { properties: object }).properties)).toEqual([
      'path',
      'recursive',
      'limit',
    ]);
    expect(Object.keys((tools.grep.parameters as { properties: object }).properties)).toEqual([
      'pattern',
      'path',
      'ignoreCase',
      'limit',
    ]);
    // The discovery tools take no required path, so the model can ask about the whole project
    // in one call without first learning that the root is /home/project.
    expect((tools.ls.parameters as { required?: string[] }).required).toBeUndefined();
    expect((tools.grep.parameters as { required?: string[] }).required).toEqual(['pattern']);
  });
});

function operationContext() {
  return {
    runWithKeepAlive: <T>(operation: () => Promise<T>) => operation(),
  };
}
