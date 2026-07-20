import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { WebContainer } from '@webcontainer/api';
import type { ActionCallbackData } from 'ghostbuild-agent/message-parser';
import { makePartId } from 'ghostbuild-agent/partId';
import { executeTool } from './action-runner/tool-executor';
import { ActionRunner } from './action-runner';
import { toolSuccess, type GhostbuildToolResult } from 'ghostbuild-agent/tool-result';

vi.mock('./action-runner/tool-executor', () => ({ executeTool: vi.fn() }));

const executeToolMock = vi.mocked(executeTool);

describe('ActionRunner duplicate tool calls', () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  test('marks a consecutive duplicate as failed and reports a tool result', async () => {
    executeToolMock.mockResolvedValue(toolSuccess('ok'));
    const onToolCallComplete = vi.fn();
    const runner = createRunner(onToolCallComplete);
    const first = toolAction('first', 'call-1', 'view', { path: 'src/app.ts' });
    const duplicate = toolAction('duplicate', 'call-2', 'view', { path: 'src/app.ts' });

    runner.addAction(first);
    await runner.runAction(first, { isStreaming: false });
    runner.addAction(duplicate);
    await runner.runAction(duplicate, { isStreaming: false });

    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(runner.actions.get().duplicate).toMatchObject({
      status: 'failed',
      executed: true,
      error: 'This exact action was already executed. Please try a different approach.',
    });
    expect(onToolCallComplete).toHaveBeenLastCalledWith({
      result: expect.objectContaining({
        ok: false,
        summary: 'This exact action was already executed. Please try a different approach.',
      }),
      toolCallId: 'call-2',
    });
  });

  test('allows the same call after another successful call', async () => {
    executeToolMock.mockResolvedValue(toolSuccess('ok'));
    const onToolCallComplete = vi.fn();
    const runner = createRunner(onToolCallComplete);
    const actions = [
      toolAction('first', 'call-1', 'view', { path: 'src/app.ts' }),
      toolAction('other', 'call-2', 'view', { path: 'src/other.ts' }),
      toolAction('retry', 'call-3', 'view', { path: 'src/app.ts' }),
    ];

    for (const action of actions) {
      runner.addAction(action);
      await runner.runAction(action, { isStreaming: false });
    }

    expect(executeToolMock).toHaveBeenCalledTimes(3);
    expect(runner.actions.get().retry).toMatchObject({ status: 'complete', executed: true });
  });

  test('allows an identical retry when the previous execution failed', async () => {
    executeToolMock.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(toolSuccess('ok'));
    const runner = createRunner(vi.fn());
    const first = toolAction('first', 'call-1', 'view', { path: 'src/app.ts' });
    const retry = toolAction('retry', 'call-2', 'view', { path: 'src/app.ts' });

    runner.addAction(first);
    await runner.runAction(first, { isStreaming: false });
    runner.addAction(retry);
    await runner.runAction(retry, { isStreaming: false });

    expect(executeToolMock).toHaveBeenCalledTimes(2);
    expect(runner.actions.get().first).toMatchObject({ status: 'failed' });
    expect(runner.actions.get().retry).toMatchObject({ status: 'complete' });
  });
});

describe('ActionRunner abort lifecycle', () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  test('does not execute an action aborted while queued', async () => {
    let resolveFirst!: (value: ReturnType<typeof toolSuccess>) => void;
    executeToolMock.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof toolSuccess>>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const runner = createRunner(vi.fn());
    const first = toolAction('first', 'call-1', 'view', { path: 'src/first.ts' });
    const queued = toolAction('queued', 'call-2', 'view', { path: 'src/queued.ts' });

    runner.addAction(first);
    const firstRun = runner.runAction(first, { isStreaming: false });
    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledOnce());
    runner.addAction(queued);
    const queuedRun = runner.runAction(queued, { isStreaming: false });
    runner.actions.get().queued.abort();
    resolveFirst(toolSuccess('ok'));
    await Promise.all([firstRun, queuedRun]);

    expect(executeToolMock).toHaveBeenCalledOnce();
    expect(runner.actions.get().queued).toMatchObject({ status: 'aborted', executed: true });
  });

  test('propagates abort to a running tool and preserves aborted status', async () => {
    executeToolMock.mockImplementation(
      ({ abortSignal }) =>
        new Promise<ReturnType<typeof toolSuccess>>((_resolve, reject) => {
          abortSignal.addEventListener(
            'abort',
            () => reject(abortSignal.reason ?? new DOMException('The operation was aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const onToolCallComplete = vi.fn();
    const runner = createRunner(onToolCallComplete);
    const action = toolAction('running', 'call-1', 'view', { path: 'src/app.ts' });

    runner.addAction(action);
    const run = runner.runAction(action, { isStreaming: false });
    await vi.waitFor(() => expect(executeToolMock).toHaveBeenCalledOnce());
    runner.actions.get().running.abort();
    await run;

    expect(runner.actions.get().running.abortSignal.aborted).toBe(true);
    expect(runner.actions.get().running.status).toBe('aborted');
    expect(onToolCallComplete).not.toHaveBeenCalled();
  });
});

test('waits for the workspace before executing a tool', async () => {
  executeToolMock.mockReset();
  executeToolMock.mockResolvedValue(toolSuccess('ok'));
  let markWorkspaceReady!: () => void;
  const waitForWorkspaceReady = new Promise<void>((resolve) => {
    markWorkspaceReady = resolve;
  });
  const runner = createRunner(vi.fn(), () => waitForWorkspaceReady);
  const action = toolAction('waiting', 'call-1', 'view', { path: 'src/app.ts' });

  runner.addAction(action);
  const run = runner.runAction(action, { isStreaming: false });
  await Promise.resolve();
  expect(executeToolMock).not.toHaveBeenCalled();

  markWorkspaceReady();
  await run;

  expect(executeToolMock).toHaveBeenCalledOnce();
});

test('reports a tool failure when workspace setup fails', async () => {
  executeToolMock.mockReset();
  const onToolCallComplete = vi.fn();
  const runner = createRunner(onToolCallComplete, async () => {
    throw new Error('Workspace setup stopped');
  });
  const action = toolAction('blocked', 'call-1', 'view', { path: 'src/app.ts' });

  runner.addAction(action);
  await runner.runAction(action, { isStreaming: false });

  expect(executeToolMock).not.toHaveBeenCalled();
  expect(onToolCallComplete).toHaveBeenCalledWith({
    result: expect.objectContaining({ ok: false, summary: expect.stringContaining('Workspace setup stopped') }),
    toolCallId: 'call-1',
  });
});

function createRunner(
  onToolCallComplete: (completion: { result: GhostbuildToolResult; toolCallId: string }) => void,
  waitForWorkspaceReady: () => Promise<unknown> = async () => undefined,
) {
  return new ActionRunner(Promise.resolve({} as WebContainer), {
    onToolCallComplete,
    waitForWorkspaceReady,
    workspace: {
      getFiles: () => ({}),
      getPreviewPort: () => undefined,
      hasFile: () => false,
      setGeneratedFileContent: vi.fn(),
    },
  });
}

function toolAction(actionId: string, toolCallId: string, toolName: string, args: unknown): ActionCallbackData {
  return {
    artifactId: 'artifact',
    partId: makePartId('message', 0),
    actionId,
    action: {
      type: 'toolUse',
      toolName,
      content: JSON.stringify(args),
      parsedContent: { state: 'call', toolCallId, toolName, args },
    },
  };
}
