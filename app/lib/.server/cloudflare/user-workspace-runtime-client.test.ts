import { describe, expect, it, vi } from 'vitest';
import { UserWorkspaceRuntimeClient } from './user-workspace-runtime-client';

describe('UserWorkspaceRuntimeClient tool operation journal', () => {
  it('returns a completed result without executing the operation again', async () => {
    const execute = vi.fn(async () => ({ shouldNotRun: true }));
    const { client, requests } = harness(() => json({ status: 'completed', result: { path: '/project/a.ts' } }));

    await expect(client.executeToolOnce('call-1', 'write', { path: '/project/a.ts' }, execute)).resolves.toEqual({
      path: '/project/a.ts',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(requests.map((request) => request.operation)).toEqual(['tool-operation/begin']);
  });

  it('fails closed when the remote journal reports an indeterminate operation', async () => {
    const execute = vi.fn(async () => ({ shouldNotRun: true }));
    const { client, requests } = harness(() =>
      json({ status: 'indeterminate', error: 'The operation may already have changed the workspace.' }),
    );

    await expect(client.executeToolOnce('call-1', 'exec', { command: 'npm test' }, execute)).rejects.toThrow(
      'may already have changed the workspace',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(requests.map((request) => request.operation)).toEqual(['tool-operation/begin']);
  });

  it('coalesces concurrent calls with the same identifier, tool, and arguments', async () => {
    let resolveExecution!: (value: { exitCode: number }) => void;
    const execution = new Promise<{ exitCode: number }>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = vi.fn(() => execution);
    const { client, requests } = harness((request) => {
      if (request.operation === 'tool-operation/begin') {
        return json({ status: 'execute' });
      }
      if (request.operation === 'tool-operation/complete') {
        return json(request.body.result);
      }
      throw new Error(`Unexpected operation: ${request.operation}`);
    });

    const first = client.executeToolOnce('call-1', 'exec', { cwd: '/', command: 'pwd' }, execute);
    const second = client.executeToolOnce('call-1', 'exec', { command: 'pwd', cwd: '/' }, execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    resolveExecution({ exitCode: 0 });

    await expect(Promise.all([first, second])).resolves.toEqual([{ exitCode: 0 }, { exitCode: 0 }]);
    expect(requests.map((request) => request.operation)).toEqual(['tool-operation/begin', 'tool-operation/complete']);
  });

  it('rejects concurrent identifier reuse with different arguments', async () => {
    let resolveExecution!: (value: { ok: true }) => void;
    const execution = new Promise<{ ok: true }>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = vi.fn(() => execution);
    const { client } = harness((request) =>
      request.operation === 'tool-operation/begin' ? json({ status: 'execute' }) : json(request.body.result),
    );

    const first = client.executeToolOnce('call-1', 'write', { path: '/project/a.ts' }, execute);
    await expect(
      client.executeToolOnce('call-1', 'write', { path: '/project/b.ts' }, async () => ({ ok: false })),
    ).rejects.toThrow('reused with different arguments');
    resolveExecution({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('records the exact successful result with the remote journal', async () => {
    const result = { path: '/project/a.ts', bytesWritten: 12 };
    const { client, requests } = harness((request) => {
      if (request.operation === 'tool-operation/begin') {
        return json({ status: 'execute' });
      }
      if (request.operation === 'tool-operation/complete') {
        return json(request.body.result);
      }
      throw new Error(`Unexpected operation: ${request.operation}`);
    });

    await expect(client.executeToolOnce('call-1', 'write', { path: result.path }, async () => result)).resolves.toEqual(
      result,
    );
    expect(requests[1]).toMatchObject({
      operation: 'tool-operation/complete',
      body: { toolCallId: 'call-1', result },
    });
  });

  it('records a failed execution and preserves the original error', async () => {
    const failure = new Error('command failed');
    const { client, requests } = harness((request) => {
      if (request.operation === 'tool-operation/begin') {
        return json({ status: 'execute' });
      }
      if (request.operation === 'tool-operation/fail') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected operation: ${request.operation}`);
    });

    await expect(
      client.executeToolOnce('call-1', 'exec', { command: 'false' }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(requests[1]).toMatchObject({
      operation: 'tool-operation/fail',
      body: { toolCallId: 'call-1', error: 'command failed' },
    });
  });
});

type JournalRequest = { operation: string; body: Record<string, unknown> };

function harness(respond: (request: JournalRequest) => Response | Promise<Response>) {
  const requests: JournalRequest[] = [];
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const operation = url.pathname.split('/').slice(4).join('/');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const journalRequest = { operation, body };
    requests.push(journalRequest);
    return respond(journalRequest);
  });
  const env = {
    GHOSTBUILD_USER_RUNTIME: '1',
    GHOSTBUILD_USER_RUNTIME_ENDPOINT: 'https://workspace.example',
    CONTROL_PLANE_SECRET: 'secret',
  } as unknown as Env;
  return {
    client: new UserWorkspaceRuntimeClient(env, 'project-1', () => 'user-1', request as unknown as typeof fetch),
    requests,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}
