import { describe, expect, it, vi } from 'vitest';
import type { GhostbuildMessage, GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { toolFailure, toolSuccess } from 'ghostbuild-agent/tool-result';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { ZodType } from 'zod';
import { COMPUTER_EXEC_APPLICATION_POLICY } from 'ghostbuild-agent/cloudflare-computer';
import {
  createTurnStatefulToolCoordinator,
  createWorkersAiTools,
  getValidatedBuildCompletion,
  getWorkersAiToolSettings,
  MODEL_TOOL_NAMES,
} from './workers-ai-tools';

type Tool = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<unknown>;
};

describe('minimal Workers AI tool surface', () => {
  it('keeps the reviewed Computer schemas behind four active model tools', () => {
    const tools = createWorkersAiTools(workspaceStub(), operationContext());

    expect(getWorkersAiToolSettings([])).toEqual({
      activeTools: MODEL_TOOL_NAMES,
      toolChoice: 'auto',
    });
    expect(
      toolInputSchema(tools.read).safeParse({ path: '/home/project/package.json', offset: 1, limit: 20 }).success,
    ).toBe(true);
    expect(toolInputSchema(tools.write).safeParse({ path: '/home/project/new.ts', content: 'export {}' }).success).toBe(
      true,
    );
    expect(
      toolInputSchema(tools.edit).safeParse({
        path: '/home/project/app.ts',
        edits: [{ oldText: 'before', newText: 'after' }],
      }).success,
    ).toBe(true);
    expect(toolInputSchema(tools.exec).safeParse({ command: 'rg TODO', backend: 'container-shell' }).success).toBe(
      true,
    );
  });

  it('presents one concrete exec backend plus the mutation policy', () => {
    const tools = createWorkersAiTools(workspaceStub(), operationContext());

    expect(tools.exec.description).toContain(COMPUTER_EXEC_APPLICATION_POLICY);
    expect(tools.exec.description).not.toContain('multiple backends');
    expect(tools.exec.description).toContain('/home/project/.ghost/docs/');
  });

  it('reads immutable bundled guidance through the normal read tool', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext());

    const index = await executeTool(tools.read, { path: '/home/project/.ghost/docs/index.md', limit: 20 });
    expect(JSON.stringify(index)).toContain('cloudflarePlatform.md');
    expect(workspace.computer.fs.readFile).not.toHaveBeenCalled();

    await expect(
      executeTool(tools.write, { path: '/home/project/.ghost/docs/index.md', content: 'replace docs' }),
    ).resolves.toEqual({ error: 'Ghostbuild documentation is an immutable virtual filesystem overlay.' });
    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it('does not validate read-only exec commands', async () => {
    const runtimeExec = vi.fn(async () => ({
      result: async () => ({ exitCode: 0, stdout: 'src\n', stderr: '' }),
    }));
    const workspace = workspaceStub({ runtimeExec });
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.exec, { command: 'rg TODO', backend: 'container-shell' })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'src\n',
    });
    expect(runtimeExec).toHaveBeenCalledWith('rg TODO', {
      cwd: undefined,
      encoding: 'utf8',
      backend: 'container-shell',
    });
    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it('automatically validates write and edit mutations', async () => {
    const validation = validationResult('prepare-deployment');
    const workspace = workspaceStub({ validation });
    const onValidationStage = vi.fn();
    const tools = createWorkersAiTools(workspace, operationContext({ onValidationStage }));

    const result = await executeTool(tools.write, {
      path: '/home/project/src/app.ts',
      content: 'export const ready = true;',
    });

    expect(result).toMatchObject({ validation });
    expect(workspace.validate).toHaveBeenCalledWith({
      toolCallId: 'tool-call:validation',
      input: {},
      abortSignal: undefined,
    });
    expect(onValidationStage.mock.calls).toEqual([
      ['tool-call', 'computer validation'],
      ['tool-call', null],
    ]);
  });

  it('does not claim completion when a failed write left the durable revision unchanged', async () => {
    const workspace = workspaceStub();
    workspace.computer.fs.writeFile = vi.fn(async () => {
      throw new Error('write failed');
    });
    const tools = createWorkersAiTools(workspace, operationContext());

    const result = await executeTool(tools.write, { path: '/home/project/src/app.ts', content: 'bad' });

    expect(result).toMatchObject({ error: expect.stringContaining('write failed') });
    expect(result).not.toHaveProperty('validation');
    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it('routes approved dependency commands through the durable installer and validates them', async () => {
    const workspace = workspaceStub({ validation: validationResult('prepare-deployment') });
    const tools = createWorkersAiTools(workspace, operationContext());

    const result = await executeTool(tools.exec, { command: 'pnpm add date-fns' });

    expect(workspace.installDependencies).toHaveBeenCalledWith({
      toolCallId: 'tool-call',
      input: { mode: 'add', packages: 'date-fns' },
      mode: 'add',
      packages: ['date-fns'],
    });
    expect(result).toMatchObject({ dependencyMutation: true, validation: { ok: true } });
    expect(workspace.computer.runtime!.exec).not.toHaveBeenCalled();
  });

  it('does not let malformed dependency commands fall through to the shell', async () => {
    const workspace = workspaceStub();
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.exec, { command: 'pnpm install' })).resolves.toMatchObject({
      error: expect.stringContaining('exec accepts only'),
    });
    expect(workspace.computer.runtime!.exec).not.toHaveBeenCalled();
    expect(workspace.installDependencies).not.toHaveBeenCalled();
  });

  it('validates an exec command only when the durable workspace revision changes', async () => {
    let revision = 1;
    const runtimeExec = vi.fn(async () => ({
      result: async () => {
        revision = 2;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }));
    const workspace = workspaceStub({ runtimeExec, revision: () => revision });
    const tools = createWorkersAiTools(workspace, operationContext());

    const result = await executeTool(tools.exec, { command: 'custom-command' });

    expect(result).toMatchObject({ validation: { ok: true } });
    expect(workspace.validate).toHaveBeenCalledOnce();
  });

  it('returns validation failures inside the mutation result for model repair', async () => {
    const validation = toolFailure('Typecheck failed', { diagnostics: ['src/app.ts:1'] });
    const workspace = workspaceStub({ validation });
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.write, { path: '/home/project/src/app.ts', content: 'bad' })).resolves.toMatchObject(
      {
        validation,
      },
    );
    expect(
      getValidatedBuildCompletion([user('Build it')], [{ toolName: 'write', result: { validation } }]),
    ).toBeUndefined();
  });

  it('derives completion from the latest automatic validation receipt', () => {
    expect(
      getValidatedBuildCompletion(
        [user('Build it')],
        [{ toolName: 'write', result: { validation: validationResult('sign-in-required') } }],
      ),
    ).toContain('Sign in when you are ready to deploy');

    expect(
      getValidatedBuildCompletion(
        [user('Build it')],
        [
          { toolName: 'write', result: { validation: validationResult('prepare-deployment') } },
          { toolName: 'edit', result: { validation: toolFailure('Build failed') } },
        ],
      ),
    ).toBeUndefined();
  });

  it('continues to recognize legacy explicit validation receipts', () => {
    expect(
      getValidatedBuildCompletion([
        user('Build it'),
        toolResult('validateProject', {}, validationResult('prepare-deployment')),
      ]),
    ).toBe('Done. I built and validated the app. It is ready for the user to review and deploy.');
  });

  it('serializes stateful work and keeps read-only work outside the queue', async () => {
    const events: string[] = [];
    let finishWrite: (() => void) | undefined;
    let keepAliveCalls = 0;
    const coordinate = createTurnStatefulToolCoordinator(async (operation) => {
      keepAliveCalls += 1;
      return operation();
    });
    const write = coordinate('write', async () => {
      events.push('write-start');
      await new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      events.push('write-end');
    });
    const validation = coordinate('validateProject', async () => events.push('validation'));
    await expect(coordinate('read', async () => 'contents')).resolves.toBe('contents');

    await Promise.resolve();
    expect(events).toEqual(['write-start']);
    finishWrite?.();
    await Promise.all([write, validation]);
    expect(events).toEqual(['write-start', 'write-end', 'validation']);
    expect(keepAliveCalls).toBe(2);
  });
});

function validationResult(nextAction: 'sign-in-required' | 'prepare-deployment') {
  return toolSuccess('validated', {
    level: 'full',
    revision: 'a'.repeat(64),
    nextAction,
  });
}

function operationContext(
  overrides: { onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void } = {},
) {
  return {
    onValidationStage: overrides.onValidationStage,
    runWithKeepAlive: <T>(operation: () => Promise<T>) => operation(),
  };
}

function workspaceStub(
  options: {
    runtimeExec?: (
      command: string,
      options: { cwd?: string; encoding: 'utf8'; backend?: string },
    ) => Promise<{ result(): Promise<{ exitCode: number; stdout: string; stderr: string }> }>;
    validation?: unknown;
    revision?: () => number;
  } = {},
): BuilderWorkspaceApi {
  const runtimeExec =
    options.runtimeExec ?? vi.fn(async () => ({ result: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }));
  let localRevision = 1;
  const revision = options.revision ?? (() => localRevision);
  const state = () => ({
    initialized: true,
    revision: revision(),
    resetRevision: 0,
    fileCount: 0,
    totalBytes: 0,
    seeding: false,
  });
  const workspace = {
    computer: {
      fs: {
        stat: vi.fn(async () => ({ size: 0, mtime: 0, mode: 0, isFile: true, isDirectory: false })),
        readFile: vi.fn(),
        writeFile: vi.fn(async () => {
          localRevision += 1;
        }),
        mkdir: vi.fn(),
        rm: vi.fn(),
        readdir: vi.fn(),
      },
      runtime: { exec: runtimeExec },
    },
    refresh: vi.fn(async () => state()),
    getState: vi.fn(() => state()),
    executeToolOnce: vi.fn(async (_toolCallId, _toolName, _input, execute) => execute()),
    installDependencies: vi.fn(async () => {
      localRevision += 1;
      return toolSuccess('installed');
    }),
    validate: vi.fn(async () => options.validation ?? validationResult('prepare-deployment')),
  };
  return workspace as unknown as BuilderWorkspaceApi;
}

function user(text: string): GhostbuildMessage {
  return { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
}

function toolResult(toolName: string, input: unknown, output: unknown): GhostbuildMessage {
  const invocation: GhostbuildToolInvocation = {
    type: 'dynamic-tool',
    state: 'output-available',
    toolCallId: crypto.randomUUID(),
    toolName,
    input,
    output,
  };
  return { id: crypto.randomUUID(), role: 'assistant', parts: [invocation] };
}

async function executeTool(definition: Tool, input: unknown, abortSignal?: AbortSignal) {
  if (!definition.execute) {
    throw new Error('Expected an executable tool.');
  }
  return definition.execute(input, { toolCallId: 'tool-call', abortSignal });
}

function toolInputSchema(definition: Tool): ZodType {
  return definition.inputSchema as ZodType;
}
