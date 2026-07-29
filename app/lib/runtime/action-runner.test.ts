import type { WebContainer } from '@webcontainer/api';
import { describe, expect, test, vi } from 'vitest';
import type { ActionCallbackData } from 'ghostbuild-agent/message-parser';
import { makePartId } from 'ghostbuild-agent/partId';
import { toolFailure, toolSuccess, type GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { ActionRunner } from './action-runner';

describe('ActionRunner server-owned tools', () => {
  test('waits for the durable server result instead of replaying a recovered call in WebContainer', async () => {
    const runner = createRunner();
    const call = toolAction('validation', 'call-1', 'validateProject', {});

    runner.addAction(call);
    await runner.runAction(call, { isStreaming: false });

    expect(runner.actions.get().validation).toMatchObject({ status: 'pending', executed: false });
  });

  test('promotes a durable tool call to its result even when the rendered input is unchanged', async () => {
    const runner = createRunner();
    const call = toolAction('validation', 'call-1', 'validateProject', {});
    const result = toolResultAction(
      'validation',
      'call-1',
      'validateProject',
      {},
      toolSuccess('Project validation passed.'),
    );

    runner.addAction(call);
    await runner.runAction(call, { isStreaming: false });
    runner.addAction(result);
    await runner.runAction(result, { isStreaming: false });

    expect(runner.actions.get().validation).toMatchObject({
      status: 'complete',
      executed: true,
      parsedContent: { state: 'result', result: expect.objectContaining({ ok: true }) },
    });
  });

  test('renders a durable failure as a completed result without retrying it in the browser', async () => {
    const runner = createRunner();
    const result = toolResultAction(
      'validation',
      'call-1',
      'validateProject',
      {},
      toolFailure('Project validation failed.'),
    );

    runner.addAction(result);
    await runner.runAction(result, { isStreaming: false });

    expect(runner.actions.get().validation).toMatchObject({
      status: 'complete',
      executed: true,
      parsedContent: { state: 'result', result: expect.objectContaining({ ok: false }) },
    });
  });
});

function createRunner() {
  return new ActionRunner(Promise.resolve({} as WebContainer), {
    workspace: {
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

function toolResultAction(
  actionId: string,
  toolCallId: string,
  toolName: string,
  args: unknown,
  result: GhostbuildToolResult,
): ActionCallbackData {
  return {
    ...toolAction(actionId, toolCallId, toolName, args),
    action: {
      type: 'toolUse',
      toolName,
      content: JSON.stringify(args),
      parsedContent: { state: 'result', toolCallId, toolName, args, result },
    },
  };
}
