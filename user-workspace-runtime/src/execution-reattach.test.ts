import { describe, expect, it } from 'vitest';
import {
  isExecutionReattachable,
  reattachExecution,
  WorkspaceExecutionNotReattachableError,
} from './execution-reattach';

describe('execution re-attachment', () => {
  it('finds the execution an interrupted instance left running in the container', async () => {
    const runtime = containerWith('tool:call-1');

    await expect(isExecutionReattachable(runtime, 'tool:call-1', 'container-shell')).resolves.toBe(true);
    expect(runtime.requests).toEqual([{ id: 'tool:call-1', backend: 'container-shell', resume: 'tail' }]);
    expect(runtime.disposed).toEqual(['tool:call-1']);
  });

  it('treats an unreachable container as unobservable rather than as a missing execution', async () => {
    const runtime = {
      getExec: () => Promise.reject(new Error('Container service disconnected')),
    };

    await expect(isExecutionReattachable(runtime, 'tool:call-1', 'container-shell')).resolves.toBe(false);
  });

  it('adopts the outcome of the still-running execution instead of starting a second one', async () => {
    const runtime = containerWith('tool:call-1');

    const handle = await reattachExecution(runtime, 'tool:call-1', 'container-shell');

    expect(await handle.result()).toEqual({ exitCode: 0, stdout: 'built', stderr: '' });
    // Everything the interrupted stream already emitted has to come back with it.
    expect(runtime.requests).toEqual([{ id: 'tool:call-1', backend: 'container-shell', resume: 'full' }]);
  });

  it('leaves an execution that is genuinely gone indeterminate and never re-runs the command', async () => {
    const runtime = containerWith();

    await expect(reattachExecution(runtime, 'tool:call-1', 'container-shell')).rejects.toThrow(
      WorkspaceExecutionNotReattachableError,
    );
    await expect(reattachExecution(runtime, 'tool:call-1', 'container-shell')).rejects.toThrow(
      /\[workspace_tool_operation_indeterminate\] The workspace restarted while this command was running/,
    );
  });

  it('carries the indeterminate code where Workers RPC preserves only a message', async () => {
    const error = new WorkspaceExecutionNotReattachableError(new Error('no such exec'));

    expect(error.code).toBe('workspace_tool_operation_indeterminate');
    expect(error.message.startsWith('[workspace_tool_operation_indeterminate] ')).toBe(true);
  });
});

function containerWith(...executionIds: string[]) {
  const requests: { id: string; backend: string; resume: string }[] = [];
  const disposed: string[] = [];
  return {
    requests,
    disposed,
    getExec: (id: string, options: { backend: string; encoding: 'utf8'; resume: 'tail' | 'full' }) => {
      requests.push({ id, backend: options.backend, resume: options.resume });
      if (!executionIds.includes(id)) {
        return Promise.reject(new Error(`No execution ${id}`));
      }
      return Promise.resolve({
        id,
        result: () => Promise.resolve({ exitCode: 0, stdout: 'built', stderr: '' }),
        [Symbol.dispose]: () => {
          disposed.push(id);
        },
      });
    },
  };
}
