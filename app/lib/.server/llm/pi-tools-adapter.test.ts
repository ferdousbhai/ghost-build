import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_TOOL_INPUT_SCHEMAS } from 'ghostbuild-agent/model-tool-inputs';
import type { Tool } from 'ghostbuild-agent/tool';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  createWorkersAiTools: vi.fn(),
}));

vi.mock('./workers-ai-tools', () => ({
  createWorkersAiTools: mocks.createWorkersAiTools,
  MODEL_TOOL_NAMES: ['read', 'write', 'edit', 'exec'],
}));

import { createPiToolBundle, piToolsToList } from './pi-tools-adapter';

describe('Pi tool adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ ok: true, summary: 'done' });
    mocks.createWorkersAiTools.mockReturnValue(
      Object.fromEntries(
        (['read', 'write', 'edit', 'exec'] as const).map((name) => [
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

  it('publishes the curated labels, schemas, and exact four-tool order', () => {
    const tools = createPiToolBundle({} as never, operationContext());

    expect(piToolsToList(tools).map(({ name, label }) => ({ name, label }))).toEqual([
      { name: 'read', label: 'Read file' },
      { name: 'write', label: 'Write file' },
      { name: 'edit', label: 'Edit file' },
      { name: 'exec', label: 'Run command' },
    ]);
    expect(Object.keys((tools.edit.parameters as { properties: object }).properties)).toEqual([
      'path',
      'base',
      'edits',
    ]);
    expect(Object.keys((tools.exec.parameters as { properties: object }).properties)).toEqual(['command', 'cwd']);
  });
});

function operationContext() {
  return {
    runWithKeepAlive: <T>(operation: () => Promise<T>) => operation(),
  };
}
