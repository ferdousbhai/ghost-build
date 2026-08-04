import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { UserWorkspaceRuntimeClient } from './user-workspace-runtime-client';

describe('UserWorkspaceRuntimeClient direct ProjectWorkspace RPC', () => {
  it('returns a completed journal receipt without executing the operation again', async () => {
    const execute = vi.fn(async () => ({ shouldNotRun: true }));
    const { client, calls } = harness((operation) =>
      operation === 'beginToolOperation' ? { status: 'completed', result: { path: '/project/a.ts' } } : undefined,
    );

    await expect(client.executeToolOnce('call-1', 'write', { path: '/project/a.ts' }, execute)).resolves.toEqual({
      path: '/project/a.ts',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(calls.map((request) => request.operation)).toEqual(['initializeProjectIdentity', 'beginToolOperation']);
  });

  it('terminalizes a committed mutation whose display acknowledgement was interrupted', async () => {
    const pending = {
      kind: 'workspace-mutation-receipt',
      version: 1,
      committed: true,
      acknowledgement: 'pending',
      tool: 'write',
      files: [],
    };
    const completed = { ...pending, acknowledgement: 'complete' };
    const execute = vi.fn(async () => ({ shouldNotRun: true }));
    const { client, stub } = harness((operation) => {
      if (operation === 'beginToolOperation') {
        return { status: 'completed', result: pending };
      }
      if (operation === 'completeToolOperation') {
        return completed;
      }
      return undefined;
    });

    await expect(client.executeToolOnce('call-1', 'write', { path: '/project/a.ts' }, execute)).resolves.toEqual(
      completed,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(stub.completeToolOperation).toHaveBeenCalledWith({ toolCallId: 'call-1', result: pending });
  });

  it('recovers a lost acknowledgement response after one write without executing it twice', async () => {
    const pending = {
      kind: 'workspace-mutation-receipt',
      version: 1,
      committed: true,
      acknowledgement: 'pending',
      tool: 'write',
      files: [{ path: '/project/a.ts' }],
    };
    const completed = { ...pending, acknowledgement: 'complete' };
    let begins = 0;
    let completions = 0;
    const execute = vi.fn(async () => ({ path: '/project/a.ts', bytesWritten: 12 }));
    const { client } = harness((operation) => {
      if (operation === 'beginToolOperation') {
        begins += 1;
        return begins === 1 ? { status: 'execute' } : { status: 'completed', result: pending };
      }
      if (operation === 'completeToolOperation') {
        completions += 1;
        if (completions === 1) {
          throw new Error('RPC response lost after durable commit');
        }
        return completed;
      }
      return undefined;
    });

    await expect(client.executeToolOnce('call-1', 'write', { path: '/project/a.ts' }, execute)).resolves.toEqual(
      completed,
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(begins).toBe(2);
    expect(completions).toBe(2);
  });

  it('fails closed when the durable journal reports an indeterminate operation', async () => {
    const execute = vi.fn(async () => ({ shouldNotRun: true }));
    const { client } = harness((operation) =>
      operation === 'beginToolOperation'
        ? { status: 'indeterminate', error: 'The operation may already have changed the workspace.' }
        : undefined,
    );

    await expect(client.executeToolOnce('call-1', 'exec', { command: 'npm test' }, execute)).rejects.toThrow(
      'may already have changed the workspace',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('coalesces concurrent calls with the same identifier and native RPC values', async () => {
    let resolveExecution!: (value: { exitCode: number }) => void;
    const execution = new Promise<{ exitCode: number }>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = vi.fn(() => execution);
    const { client, calls } = harness((operation, value) => {
      if (operation === 'beginToolOperation') {
        return { status: 'execute' };
      }
      if (operation === 'completeToolOperation') {
        return record(value).result;
      }
      return undefined;
    });

    const first = client.executeToolOnce('call-1', 'exec', { cwd: '/', command: 'pwd' }, execute);
    const second = client.executeToolOnce('call-1', 'exec', { command: 'pwd', cwd: '/' }, execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    resolveExecution({ exitCode: 0 });

    await expect(Promise.all([first, second])).resolves.toEqual([{ exitCode: 0 }, { exitCode: 0 }]);
    expect(calls.map((request) => request.operation)).toEqual([
      'initializeProjectIdentity',
      'beginToolOperation',
      'completeToolOperation',
    ]);
  });

  it('rejects concurrent identifier reuse with different arguments', async () => {
    let resolveExecution!: (value: { ok: true }) => void;
    const execution = new Promise<{ ok: true }>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = vi.fn(() => execution);
    const { client } = harness((operation, value) =>
      operation === 'beginToolOperation' ? { status: 'execute' } : record(value).result,
    );

    const first = client.executeToolOnce('call-1', 'write', { path: '/project/a.ts' }, execute);
    await expect(
      client.executeToolOnce('call-1', 'write', { path: '/project/b.ts' }, async () => ({ ok: false })),
    ).rejects.toThrow('reused with different arguments');
    resolveExecution({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('propagates typed stub failures and preserves the original tool error', async () => {
    const failure = new Error('command failed');
    const { client, stub } = harness((operation) =>
      operation === 'beginToolOperation' ? { status: 'execute' } : undefined,
    );

    await expect(
      client.executeToolOnce('call-1', 'exec', { command: 'false' }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(stub.failToolOperation).toHaveBeenCalledWith({ toolCallId: 'call-1', error: 'command failed' });
  });

  it('does not mark a command failed when RPC preserved only the pending-sync message marker', async () => {
    const rpcError = new Error('[workspace_sync_pending] Computer synchronization is pending.');
    rpcError.name = 'Error';
    const { client, stub } = harness((operation) =>
      operation === 'beginToolOperation' ? { status: 'execute' } : undefined,
    );

    await expect(
      client.executeToolOnce('call-1', 'exec', { command: 'touch file' }, async () => {
        throw rpcError;
      }),
    ).rejects.toBe(rpcError);

    expect(stub.failToolOperation).not.toHaveBeenCalled();
  });

  it('rejects the normal error object returned by the official Computer exec wrapper without closing the journal', async () => {
    const { client, stub } = harness((operation) =>
      operation === 'beginToolOperation' ? { status: 'execute' } : undefined,
    );

    await expect(
      client.executeToolOnce('call-1', 'exec', { command: 'touch file' }, async () => ({
        command: 'touch file',
        backend: 'container-shell',
        error: '[workspace_sync_pending] Computer synchronization is pending.',
      })),
    ).rejects.toMatchObject({ code: 'workspace_sync_pending' });

    expect(stub.completeToolOperation).not.toHaveBeenCalled();
    expect(stub.failToolOperation).not.toHaveBeenCalled();
  });

  it('uses RPC-native bytes and streams and performs no internal HTTP fetch', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const stream = new Blob([bytes]).stream();
    const { client, stub, namespace } = harness((operation) => {
      if (operation === 'readWorkspaceFile') {
        return {
          path: '/home/project/blob.bin',
          bytes,
          encoding: 'base64',
          size: bytes.byteLength,
          mode: 0o100644,
          sha256: 'a'.repeat(64),
          revision: 1,
        };
      }
      if (operation === 'streamWorkspaceFile') {
        return stream;
      }
      return undefined;
    });

    await expect(client.readFile('/home/project/blob.bin')).resolves.toMatchObject({ bytes });
    await expect(client.computer.fs.readFile('/home/project/blob.bin')).resolves.toBe(stream);
    expect(namespace.idFromName).toHaveBeenCalledWith('project-1');
    expect(stub.initializeProjectIdentity).toHaveBeenCalledWith({ projectId: 'project-1', userId: 'user-1' });

    const source = readFileSync(new URL('./user-workspace-runtime-client.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('authorization');
    expect(source).not.toContain('base64');
    expect(source).not.toContain('/v1/projects/');
  });

  it('rejects a user mismatch before resolving a project stub', async () => {
    const { namespace } = harness(() => undefined, 'different-user');
    const client = new UserWorkspaceRuntimeClient(
      {
        GHOSTBUILD_USER_RUNTIME: '1',
        GHOSTBUILD_USER_ID: 'user-1',
        PROJECT_WORKSPACE: namespace,
      } as unknown as Env,
      'project-1',
      () => 'different-user',
    );

    await expect(client.readText('/home/project/a.ts')).rejects.toThrow('not configured for this project owner');
    expect(namespace.get).not.toHaveBeenCalled();
  });
});

type RpcCall = { operation: string; value: unknown };

function harness(respond: (operation: string, value: unknown) => unknown, userId = 'user-1') {
  const calls: RpcCall[] = [];
  const method = (operation: string) =>
    vi.fn(async (value?: unknown, second?: unknown) => {
      const payload = second === undefined ? value : [value, second];
      calls.push({ operation, value: payload });
      return respond(operation, payload);
    });
  const stub = {
    initializeProjectIdentity: method('initializeProjectIdentity'),
    beginToolOperation: method('beginToolOperation'),
    completeToolOperation: method('completeToolOperation'),
    failToolOperation: method('failToolOperation'),
    readWorkspaceFile: method('readWorkspaceFile'),
    streamWorkspaceFile: method('streamWorkspaceFile'),
  };
  const namespace = {
    idFromName: vi.fn(() => ({ id: 'project-do-id' })),
    get: vi.fn(() => stub),
  };
  const env = {
    GHOSTBUILD_USER_RUNTIME: '1',
    GHOSTBUILD_USER_ID: userId,
    PROJECT_WORKSPACE: namespace,
  } as unknown as Env;
  return {
    client: new UserWorkspaceRuntimeClient(env, 'project-1', () => userId),
    calls,
    stub,
    namespace,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
