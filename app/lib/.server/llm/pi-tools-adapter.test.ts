import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ghostbuild-agent/pi-tool-compat';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  createWorkersAiTools: vi.fn(),
}));

vi.mock('./workers-ai-tools', () => ({
  createWorkersAiTools: mocks.createWorkersAiTools,
}));

import { createPiToolBundle, createPiTools } from './pi-tools-adapter';

describe('Pi tool adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ ok: true, summary: 'done' });
    mocks.createWorkersAiTools.mockReturnValue(
      Object.fromEntries(
        ['read', 'ls', 'write', 'edit', 'exec', 'lookupDocs', 'npmInstall', 'validateProject', 'deploy'].map((name) => [
          name,
          { description: `${name} description`, execute: mocks.execute } satisfies Tool,
        ]),
      ),
    );
  });

  it('delegates computer execution to the canonical wrapped tool', async () => {
    const tools = createPiTools({} as never, operationContext());
    const signal = new AbortController().signal;

    await tools.write!.execute('write-1', { path: '/home/project/src/app.ts', content: 'export {};' }, signal);

    expect(mocks.execute).toHaveBeenCalledWith(
      { path: '/home/project/src/app.ts', content: 'export {};' },
      { toolCallId: 'write-1', abortSignal: signal },
    );
  });

  it('publishes the exact computer and install argument contracts', () => {
    const tools = createPiTools({} as never, operationContext());

    expect(Object.keys((tools.edit!.parameters as { properties: object }).properties)).toEqual(['path', 'edits']);
    expect(Object.keys((tools.exec!.parameters as { properties: object }).properties)).toEqual([
      'command',
      'cwd',
      'backend',
    ]);
    expect(Object.keys((tools.npmInstall!.parameters as { properties: object }).properties)).toEqual([
      'mode',
      'packages',
    ]);
  });

  it('returns the canonical tools alongside their Pi adapters', () => {
    const canonicalTools = mocks.createWorkersAiTools();
    mocks.createWorkersAiTools.mockReturnValueOnce(canonicalTools);

    const bundle = createPiToolBundle({} as never, operationContext());

    expect(bundle.canonicalTools).toBe(canonicalTools);
    expect(Object.keys(bundle.piTools)).toEqual(Object.keys(canonicalTools));
  });
});

function operationContext() {
  return {
    env: {} as Env,
    userId: 'user-1',
    chatInitialId: 'chat-1',
    agentName: 'agent-1',
    runWithKeepAlive: <T>(operation: () => Promise<T>) => operation(),
  };
}
