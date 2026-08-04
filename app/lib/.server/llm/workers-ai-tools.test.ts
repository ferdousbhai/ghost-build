import { describe, expect, it, vi } from 'vitest';
import type { GhostbuildMessage, GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { toolFailure, toolSuccess } from 'ghostbuild-agent/tool-result';
import type { Tool, ToolExecutionOptions } from 'ai';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { ZodType } from 'zod';
import { COMPUTER_TOOL_NAMES } from 'ghostbuild-agent/cloudflare-computer';
import {
  createWorkersAiTools,
  createTurnStatefulToolCoordinator,
  getValidatedBuildCompletion,
  getWorkersAiToolSettings,
} from './workers-ai-tools';

const AUTOMATIC_TOOLS = [...COMPUTER_TOOL_NAMES, 'lookupDocs', 'npmInstall', 'validateProject'];

describe('Workers AI tool lifecycle', () => {
  it('exposes the clean-break Cloudflare Computer filesystem schemas', () => {
    const tools = createWorkersAiTools(
      workspaceStub(async () => ({ result: async () => ({ exitCode: 0, stdout: '', stderr: '' }) })),
      operationContext(),
    );

    expect(
      toolInputSchema(tools.read).safeParse({ path: '/home/project/package.json', offset: 1, limit: 20 }).success,
    ).toBe(true);
    expect(toolInputSchema(tools.ls).safeParse({ path: '/home/project/src' }).success).toBe(true);
    expect(toolInputSchema(tools.write).safeParse({ path: '/home/project/new.ts', content: 'export {}' }).success).toBe(
      true,
    );
    expect(
      toolInputSchema(tools.edit).safeParse({
        path: '/home/project/app.ts',
        edits: [{ oldText: 'const before = true;', newText: 'const after = true;' }],
      }).success,
    ).toBe(true);
    expect(
      toolInputSchema(tools.edit).safeParse({
        path: '/home/project/app.ts',
        edits: [{ old: 'const before = true;', new: 'const after = true;' }],
      }).success,
    ).toBe(false);
  });

  it('uses the official Computer exec contract and forwards the selected backend', async () => {
    const runtimeExec = vi.fn(async () => ({
      result: async () => ({ exitCode: 0, stdout: 'checked\n', stderr: '' }),
    }));
    const workspace = workspaceStub(runtimeExec);
    const tools = createWorkersAiTools(workspace, operationContext());
    const input = {
      command: 'pnpm test',
      cwd: '/home/project',
      backend: 'container-shell',
    };

    await expect(executeTool(tools.exec, input)).resolves.toEqual({
      ...input,
      exitCode: 0,
      stdout: 'checked\n',
      stderr: '',
    });
    expect(runtimeExec).toHaveBeenCalledWith('pnpm test', {
      cwd: '/home/project',
      encoding: 'utf8',
      backend: 'container-shell',
    });
    expect(workspace.executeToolOnce).toHaveBeenCalledWith('tool-call', 'exec', input, expect.any(Function));
    expect(workspace.refresh).toHaveBeenCalledOnce();
  });

  it('defaults Computer exec to worker-shell without changing its result shape', async () => {
    const runtimeExec = vi.fn(async () => ({
      result: async () => ({ exitCode: 0, stdout: 'src\n', stderr: '' }),
    }));
    const tools = createWorkersAiTools(workspaceStub(runtimeExec), operationContext());

    await expect(executeTool(tools.exec, { command: 'ls /home/project' })).resolves.toEqual({
      command: 'ls /home/project',
      cwd: null,
      backend: 'worker-shell',
      exitCode: 0,
      stdout: 'src\n',
      stderr: '',
    });
    expect(runtimeExec).toHaveBeenCalledWith('ls /home/project', {
      cwd: undefined,
      encoding: 'utf8',
      backend: 'worker-shell',
    });
  });

  it('serializes writes and validation in model tool-call order', async () => {
    const coordinate = createTurnStatefulToolCoordinator();
    let finishWrite: (() => void) | undefined;
    const events: string[] = [];
    const write = coordinate('write', async () => {
      events.push('write-start');
      await new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      events.push('write-end');
    });
    const validation = coordinate('validateProject', async () => {
      events.push('validate-start');
    });

    await Promise.resolve();
    expect(events).toEqual(['write-start']);
    finishWrite?.();
    await Promise.all([write, validation]);
    expect(events).toEqual(['write-start', 'write-end', 'validate-start']);
  });

  it('does not let a failed stateful tool block the remaining turn', async () => {
    const coordinate = createTurnStatefulToolCoordinator();
    const failedWrite = coordinate('write', async () => {
      throw new Error('write failed');
    });
    const validation = coordinate('validateProject', async () => 'validated');

    await expect(failedWrite).rejects.toThrow('write failed');
    await expect(validation).resolves.toBe('validated');
  });

  it('gives the model all non-deployment tools before a mutation', () => {
    expect(getWorkersAiToolSettings([user('Build a habit tracker')])).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });

    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('read', {}, { path: '/home/project/package.json', content: '{}' }),
        toolResult('lookupDocs', {}, toolSuccess('looked up guidance')),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });
  });

  it('requires concrete implementation or validation work after a successful current-turn mutation', () => {
    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('write', { path: '/home/project/src/router.tsx' }, writeResult()),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'required',
    });
  });

  it('does not invent mutation metadata for successful Computer exec results', () => {
    expect(
      getWorkersAiToolSettings([
        user('Explain the project'),
        toolResult('exec', { command: 'rg TODO' }, { exitCode: 0, stdout: '', stderr: '' }),
      ]),
    ).toEqual({ activeTools: AUTOMATIC_TOOLS, toolChoice: 'auto' });
  });

  it('requires implementation work after dependency setup instead of forcing premature validation', () => {
    expect(
      getWorkersAiToolSettings([
        user('Build a Three.js game'),
        toolResult('npmInstall', { packages: 'three @types/three' }, toolSuccess('installed')),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS.filter((toolName) => toolName !== 'validateProject'),
      toolChoice: 'required',
    });
  });

  it('uses every result in a multi-tool model step', () => {
    expect(
      getWorkersAiToolSettings(
        [user('Build a habit tracker')],
        [
          { toolName: 'write', result: writeResult() },
          { toolName: 'read', result: { path: '/home/project/package.json', content: '{}' } },
        ],
      ),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'required',
    });
  });

  it('finishes an unfinished mutation before starting a later turn', () => {
    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('write', { path: '/home/project/src/routes/index.tsx' }, writeResult()),
        { ...user('Is it ready?'), id: 'user-2' },
      ]),
    ).toEqual({
      activeTools: ['validateProject'],
      toolChoice: 'required',
    });
  });

  it('returns control after read failures and requires repair work after validation failures', () => {
    expect(
      getWorkersAiToolSettings([
        user('Explain the project'),
        toolResult('read', {}, { error: 'Unable to read that range' }),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'auto',
    });

    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('write', {}, writeResult()),
        toolResult('validateProject', {}, toolFailure('Preview validation failed')),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'required',
    });

    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('write', {}, writeResult()),
        toolResult('validateProject', {}, toolSuccess('missing next action', { level: 'full', revision: 'abc' })),
      ]),
    ).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'required',
    });
  });

  it('prepares deployment only after exact-revision validation', () => {
    const messages = [
      user('Build a habit tracker'),
      toolResult('write', {}, writeResult()),
      toolResult('validateProject', {}, validationResult('prepare-deployment', 'abc')),
    ];
    expect(getWorkersAiToolSettings(messages)).toEqual({
      activeTools: ['deploy'],
      toolChoice: 'required',
    });

    expect(
      getWorkersAiToolSettings([
        ...messages,
        toolResult('deploy', { validatedRevision: 'abc' }, toolFailure('Cloudflare is temporarily unavailable')),
      ]),
    ).toEqual({
      activeTools: [...AUTOMATIC_TOOLS, 'deploy'],
      toolChoice: 'required',
    });

    expect(
      getWorkersAiToolSettings([
        ...messages,
        toolResult(
          'deploy',
          { validatedRevision: 'abc' },
          toolSuccess('ready', { state: 'awaiting-approval', revision: 'abc' }),
        ),
      ]),
    ).toEqual({ toolChoice: 'none' });
  });

  it('stops tool work after guest validation', () => {
    expect(
      getWorkersAiToolSettings([
        user('Build a habit tracker'),
        toolResult('write', {}, writeResult()),
        toolResult('validateProject', {}, validationResult('sign-in-required')),
      ]),
    ).toEqual({ toolChoice: 'none' });
  });

  it('returns deterministic completion copy from validated lifecycle receipts', () => {
    expect(
      getValidatedBuildCompletion([
        user('Build a habit tracker'),
        toolResult('write', {}, writeResult()),
        toolResult('validateProject', {}, validationResult('sign-in-required')),
      ]),
    ).toBe(
      'Done. I built and validated the app in the isolated production build environment, and it is ready to preview here. Sign in when you are ready to deploy it to Cloudflare production.',
    );
  });

  it('returns deterministic approval copy from tool results produced in the current model call', () => {
    expect(
      getValidatedBuildCompletion(
        [user('Build a habit tracker')],
        [
          { toolName: 'write', result: writeResult() },
          { toolName: 'validateProject', result: validationResult('prepare-deployment') },
          {
            toolName: 'deploy',
            result: toolSuccess('ready', { state: 'awaiting-approval', revision: 'a'.repeat(64) }),
          },
        ],
      ),
    ).toBe('Done. I built and validated the app. The production deployment plan is ready for your approval.');
  });

  it('does not complete from an obsolete successful validation receipt', () => {
    const messages = [
      user('Build a habit tracker'),
      toolResult('write', {}, writeResult()),
      toolResult('validateProject', {}, validationResult('sign-in-required')),
      toolResult('validateProject', {}, toolFailure('The project no longer validates')),
    ];

    expect(getWorkersAiToolSettings(messages)).toEqual({
      activeTools: AUTOMATIC_TOOLS,
      toolChoice: 'required',
    });
    expect(getValidatedBuildCompletion(messages)).toBeUndefined();
  });
});

function user(text: string): GhostbuildMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

function toolResult(toolName: string, args: unknown, result: unknown): GhostbuildMessage {
  const invocation: GhostbuildToolInvocation = {
    state: 'result',
    toolCallId: crypto.randomUUID(),
    toolName,
    args,
    result,
  };
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [{ type: 'tool-invocation', toolInvocation: invocation }],
  };
}

function validationResult(nextAction: 'sign-in-required' | 'prepare-deployment', revision = 'a'.repeat(64)) {
  return toolSuccess('validated', {
    level: 'full',
    revision,
    nextAction,
  });
}

function writeResult() {
  return { path: '/home/project/src/routes/index.tsx', bytesWritten: 42 };
}

function operationContext() {
  return {
    env: {} as Env,
    userId: 'user',
    chatInitialId: 'chat',
    agentName: 'agent',
  };
}

function workspaceStub(
  runtimeExec: (
    command: string,
    options: { cwd?: string; encoding: 'utf8'; backend?: string },
  ) => Promise<{
    result(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }>,
): BuilderWorkspaceApi {
  const state = {
    initialized: true,
    revision: 1,
    resetRevision: 0,
    fileCount: 0,
    totalBytes: 0,
    seeding: false,
  };
  return {
    computer: {
      fs: {
        stat: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        rm: vi.fn(),
        readdir: vi.fn(),
      },
      runtime: { exec: runtimeExec },
    },
    refresh: vi.fn(async () => state),
    getState: vi.fn(() => state),
    executeToolOnce: vi.fn(async (_toolCallId, _toolName, _input, execute) => execute()),
  } as unknown as BuilderWorkspaceApi;
}

async function executeTool(definition: Tool, input: unknown) {
  if (!definition.execute) {
    throw new Error('Expected an executable tool.');
  }
  const options: ToolExecutionOptions = { toolCallId: 'tool-call', messages: [] };
  return definition.execute(input as never, options);
}

function toolInputSchema(definition: Tool): ZodType {
  return definition.inputSchema as ZodType;
}
