import { describe, expect, it, vi } from 'vitest';
import type { GhostbuildMessage, GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { toolFailure, toolSuccess } from 'ghostbuild-agent/tool-result';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';

type Tool = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, options: ToolExecutionOptions) => Promise<unknown>;
};
type ToolExecutionOptions = { toolCallId: string; abortSignal?: AbortSignal };
import type { ZodType } from 'zod';
import { COMPUTER_EXEC_APPLICATION_POLICY, COMPUTER_TOOL_NAMES } from 'ghostbuild-agent/cloudflare-computer';
import { UserWorkspaceRuntimeClient } from '~/lib/.server/cloudflare/user-workspace-runtime-client';
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

    expect(tools.exec.description).toContain(COMPUTER_EXEC_APPLICATION_POLICY);
    expect(tools.exec.description).not.toContain('multiple backends');

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

  it('defaults Computer exec to the production container backend without changing its result shape', async () => {
    const runtimeExec = vi.fn(async () => ({
      result: async () => ({ exitCode: 0, stdout: 'src\n', stderr: '' }),
    }));
    const tools = createWorkersAiTools(workspaceStub(runtimeExec), operationContext());

    await expect(executeTool(tools.exec, { command: 'ls /home/project' })).resolves.toEqual({
      command: 'ls /home/project',
      cwd: null,
      backend: 'container-shell',
      exitCode: 0,
      stdout: 'src\n',
      stderr: '',
    });
    expect(runtimeExec).toHaveBeenCalledWith('ls /home/project', {
      cwd: undefined,
      encoding: 'utf8',
      backend: 'container-shell',
    });
  });

  it('turns the official Computer exec error wrapper into a typed nonterminal sync result', async () => {
    const completeToolOperation = vi.fn();
    const failToolOperation = vi.fn();
    const stub = {
      initializeProjectIdentity: vi.fn(),
      beginToolOperation: vi.fn().mockResolvedValue({ status: 'execute' }),
      completeToolOperation,
      failToolOperation,
      execute: vi.fn().mockRejectedValue(new Error('[workspace_sync_pending] Computer synchronization is pending.')),
      getWorkspaceState: vi.fn(),
      listWorkspaceFiles: vi.fn(),
    };
    const workspace = new UserWorkspaceRuntimeClient(
      {
        GHOSTBUILD_USER_RUNTIME: '1',
        GHOSTBUILD_USER_ID: 'user-1',
        PROJECT_WORKSPACE: {
          idFromName: vi.fn(() => ({ id: 'project-1' })),
          get: vi.fn(() => stub),
        },
      } as unknown as Env,
      'project-1',
      () => 'user-1',
    );
    const tools = createWorkersAiTools(workspace, operationContext());

    await expect(executeTool(tools.exec, { command: 'touch marker', backend: 'container-shell' })).resolves.toEqual({
      kind: 'workspace-sync-unconfirmed',
      version: 1,
      acknowledgement: 'pending',
      status: 'pending',
      code: 'workspace_sync_pending',
      error: '[workspace_sync_pending] Computer synchronization is pending.',
    });
    expect(completeToolOperation).not.toHaveBeenCalled();
    expect(failToolOperation).not.toHaveBeenCalled();
  });

  it('does not start a queued Computer tool after the turn is aborted', async () => {
    const runtimeExec = vi.fn();
    const workspace = workspaceStub(runtimeExec);
    const tools = createWorkersAiTools(workspace, operationContext());
    const controller = new AbortController();
    controller.abort(new Error('turn aborted'));

    await expect(executeTool(tools.read, { path: '/home/project/source.ts' }, controller.signal)).rejects.toThrow(
      'turn aborted',
    );
    expect(workspace.computer.fs.stat).not.toHaveBeenCalled();
    expect(runtimeExec).not.toHaveBeenCalled();
  });

  it('serializes writes and validation in model tool-call order', async () => {
    const coordinate = createTurnStatefulToolCoordinator((operation) => operation());
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
    const coordinate = createTurnStatefulToolCoordinator((operation) => operation());
    const failedWrite = coordinate('write', async () => {
      throw new Error('write failed');
    });
    const validation = coordinate('validateProject', async () => 'validated');

    await expect(failedWrite).rejects.toThrow('write failed');
    await expect(validation).resolves.toBe('validated');
  });

  it('keeps the agent alive while a stateful tool runs', async () => {
    const events: string[] = [];
    let keepAliveCalls = 0;
    const runWithKeepAlive = async <T>(operation: () => Promise<T>): Promise<T> => {
      keepAliveCalls += 1;
      events.push('keep-alive-start');
      const result = await operation();
      events.push('keep-alive-end');
      return result;
    };
    const coordinate = createTurnStatefulToolCoordinator(runWithKeepAlive);

    await expect(
      coordinate('validateProject', async () => {
        events.push('validation');
        return 'validated';
      }),
    ).resolves.toBe('validated');

    expect(events).toEqual(['keep-alive-start', 'validation', 'keep-alive-end']);
    expect(keepAliveCalls).toBe(1);
  });

  it('releases keep-alive after a failure and keeps the stateful queue usable', async () => {
    const events: string[] = [];
    const runWithKeepAlive = async <T>(operation: () => Promise<T>): Promise<T> => {
      events.push('keep-alive-start');
      try {
        return await operation();
      } finally {
        events.push('keep-alive-end');
      }
    };
    const coordinate = createTurnStatefulToolCoordinator(runWithKeepAlive);

    const failedWrite = coordinate('write', async () => {
      events.push('write');
      throw new Error('write failed');
    });
    const validation = coordinate('validateProject', async () => {
      events.push('validation');
      return 'validated';
    });

    await expect(failedWrite).rejects.toThrow('write failed');
    await expect(validation).resolves.toBe('validated');
    expect(events).toEqual([
      'keep-alive-start',
      'write',
      'keep-alive-end',
      'keep-alive-start',
      'validation',
      'keep-alive-end',
    ]);
  });

  it('does not keep the agent alive for read-only tools', async () => {
    let keepAliveCalls = 0;
    const runWithKeepAlive = <T>(operation: () => Promise<T>): Promise<T> => {
      keepAliveCalls += 1;
      return operation();
    };
    const coordinate = createTurnStatefulToolCoordinator(runWithKeepAlive);

    await expect(coordinate('read', async () => 'contents')).resolves.toBe('contents');
    await expect(coordinate('ls', async () => ['src'])).resolves.toEqual(['src']);
    await expect(coordinate('lookupDocs', async () => 'guidance')).resolves.toBe('guidance');

    expect(keepAliveCalls).toBe(0);
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

  it('requires concrete implementation or validation work after native and recovered mutations', () => {
    for (const [toolName, result] of [
      ['write', writeResult()],
      [
        'edit',
        {
          path: '/home/project/src/router.tsx',
          editsApplied: 1,
          diff: '',
          patch: '',
          firstChangedLine: 1,
        },
      ],
      ['write', writeReceipt()],
    ] as const) {
      expect(
        getWorkersAiToolSettings([
          user('Build a habit tracker'),
          toolResult(toolName, { path: '/home/project/src/router.tsx' }, result),
        ]),
      ).toEqual({
        activeTools: AUTOMATIC_TOOLS,
        toolChoice: 'required',
      });
    }
  });

  it('does not treat malformed, pending, or failed write output as a committed implementation mutation', () => {
    const base = [user('Build a habit tracker')];
    for (const result of [
      { path: '/home/project/a.ts' },
      { path: '/home/project/a.ts', bytesWritten: -1 },
      { ...writeReceipt(), acknowledgement: 'pending' },
      { ...writeReceipt(), committed: false },
      { error: 'write failed' },
    ]) {
      expect(getWorkersAiToolSettings([...base, toolResult('write', {}, result)])).toEqual({
        activeTools: AUTOMATIC_TOOLS,
        toolChoice: 'auto',
      });
    }
  });

  it('conservatively requires validation after every attempted model-facing Computer exec', () => {
    for (const result of [
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 1, stdout: '', stderr: 'failed after writing' },
      { error: 'timed out after writing' },
      {
        kind: 'workspace-sync-unconfirmed',
        version: 1,
        acknowledgement: 'pending',
        status: 'pending',
        code: 'workspace_sync_pending',
      },
    ]) {
      expect(
        getWorkersAiToolSettings([user('Explain the project'), toolResult('exec', { command: 'rg TODO' }, result)]),
      ).toEqual({ activeTools: AUTOMATIC_TOOLS, toolChoice: 'required' });
    }
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

  it('invalidates validation when dependency installation fails after a possible manifest or lockfile write', () => {
    expect(
      getWorkersAiToolSettings([
        user('Add a chart'),
        toolResult('npmInstall', { packages: 'recharts' }, toolFailure('pnpm failed after updating the lockfile')),
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
    type: 'dynamic-tool',
    state: 'output-available',
    toolCallId: crypto.randomUUID(),
    toolName,
    input: args,
    output: result,
  };
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [invocation],
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
  return {
    path: '/home/project/src/routes/index.tsx',
    bytesWritten: 42,
  };
}

function writeReceipt() {
  return {
    kind: 'workspace-mutation-receipt',
    version: 1,
    committed: true,
    acknowledgement: 'complete',
    tool: 'write',
    files: [
      {
        path: '/home/project/src/routes/index.tsx',
        revision: 2,
        size: 42,
        sha256: 'a'.repeat(64),
        deleted: false,
      },
    ],
    changedRanges: [],
    diffSummary: null,
    truncated: { result: false, diff: false, paths: false, omittedBytes: 0 },
  };
}

function operationContext() {
  return {
    env: {} as Env,
    userId: 'user',
    chatInitialId: 'chat',
    agentName: 'agent',
    runWithKeepAlive: <T>(operation: () => Promise<T>) => operation(),
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

async function executeTool(definition: Tool, input: unknown, abortSignal?: AbortSignal) {
  if (!definition.execute) {
    throw new Error('Expected an executable tool.');
  }
  const options: ToolExecutionOptions = {
    toolCallId: 'tool-call',
    abortSignal,
  };
  return definition.execute(input, options);
}

function toolInputSchema(definition: Tool): ZodType {
  return definition.inputSchema as ZodType;
}
