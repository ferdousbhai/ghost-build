import type { WebContainer } from '@webcontainer/api';
import { atom, map, type WritableAtom } from 'nanostores';
import type { ActionAlert } from '~/types/actions';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { unreachable } from 'ghostbuild-agent/utils/unreachable';
import type { ActionCallbackData } from 'ghostbuild-agent/message-parser';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { ActionCommandError, boundedErrorMessage } from './action-runner/errors';
import { isFileMutationTool, runStreamedFileAction } from './action-runner/file-tools';
import { executeTool } from './action-runner/tool-executor';
import type { ActionRunnerWorkspace, ActionsMap, ActionState, ActionStateUpdate } from './action-runner/types';
import { toolFailure, type GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { ToolExecutionScheduler } from './action-runner/tool-execution-scheduler';
import { DiagnosticsStore } from './action-runner/diagnostics-store';
import { ContainerBootState, waitForContainerBootState } from '~/lib/stores/containerBootState';
import { DeploymentValidationStore } from './action-runner/deployment-validation-store';
import { createWebContainerBuildExecutor, type ProjectBuildExecutor } from './action-runner/project-build-executor';

export { isActionStatusActive } from './action-runner/types';
export type { ActionState, ActionStatus } from './action-runner/types';

const logger = createScopedLogger('ActionRunner');

type ToolCompletion = {
  result: GhostbuildToolResult;
  toolCallId: string;
};

class ToolReportedFailure extends Error {}

export class ActionRunner {
  #currentExecution: Promise<void> = Promise.resolve();
  #lastSuccessfulToolCallKey: string | null = null;
  readonly #diagnostics: DiagnosticsStore;
  readonly #deploymentValidation = new DeploymentValidationStore();
  readonly #scheduler: ToolExecutionScheduler;

  readonly actions: ActionsMap = map({});
  readonly terminalOutput: WritableAtom<string> = atom('');

  constructor(
    private readonly webcontainer: Promise<WebContainer>,
    private readonly callbacks: {
      onAlert?: (alert: ActionAlert) => void;
      onToolCallComplete: (args: ToolCompletion) => void;
      workspace: ActionRunnerWorkspace;
      diagnostics?: DiagnosticsStore;
      scheduler?: ToolExecutionScheduler;
      waitForWorkspaceReady?: () => Promise<unknown> | undefined;
      buildExecutor?: ProjectBuildExecutor;
    },
  ) {
    this.#diagnostics = callbacks.diagnostics ?? new DiagnosticsStore();
    this.#scheduler = callbacks.scheduler ?? new ToolExecutionScheduler();
  }

  addAction(data: ActionCallbackData): void {
    const { actionId } = data;
    const existingAction = this.actions.get()[actionId];
    if (existingAction) {
      if (existingAction.content !== data.action.content) {
        this.actions.setKey(actionId, { ...existingAction, ...data.action });
      }
      return;
    }

    const abortController = new AbortController();
    if (data.action.type === 'file') {
      data.action.isEdit = this.callbacks.workspace.hasFile(getAbsolutePath(data.action.filePath));
    }
    this.actions.setKey(actionId, {
      ...data.action,
      status: 'pending',
      executed: false,
      abort: () => {
        abortController.abort();
        this.updateAction(actionId, { status: 'aborted' });
      },
      abortSignal: abortController.signal,
    });
  }

  async runAction(data: ActionCallbackData, args: { isStreaming: boolean }): Promise<void> {
    const action = this.actions.get()[data.actionId];
    if (!action) {
      unreachable(`Action ${data.actionId} not found`);
    }
    if (action.executed || (args.isStreaming && action.type !== 'file')) {
      return;
    }
    if (action.type === 'toolUse' && this.rejectDuplicateToolCall(data.actionId, action)) {
      return;
    }

    this.updateAction(data.actionId, { ...action, ...data.action, executed: !args.isStreaming });
    this.#currentExecution = this.#currentExecution
      .then(() => this.executeAction(data.actionId, args.isStreaming))
      .catch((error) => logger.error('Action failed:', error));
    await this.#currentExecution;
  }

  updateAction(id: string, newState: ActionStateUpdate): void {
    this.actions.setKey(id, { ...this.actions.get()[id], ...newState });
  }

  private rejectDuplicateToolCall(actionId: string, action: ActionState): boolean {
    if (action.type !== 'toolUse' || action.parsedContent.state !== 'call') {
      return false;
    }
    const invocation = action.parsedContent;
    if (toolCallKey(invocation) !== this.#lastSuccessfulToolCallKey) {
      return false;
    }
    const error = 'This exact action was already executed. Please try a different approach.';
    this.updateAction(actionId, { executed: true, status: 'failed', error });
    this.callbacks.onToolCallComplete({
      result: toolFailure(error),
      toolCallId: invocation.toolCallId,
    });
    return true;
  }

  private async executeAction(actionId: string, isStreaming: boolean): Promise<void> {
    const action = this.actions.get()[actionId];
    if (action.abortSignal.aborted) {
      this.updateAction(actionId, { status: 'aborted' });
      return;
    }
    this.updateAction(actionId, { status: 'running' });

    try {
      if (action.type === 'file') {
        await this.waitForWorkspaceReady();
        await runStreamedFileAction(action, await this.webcontainer, this.callbacks.workspace);
        this.#lastSuccessfulToolCallKey = null;
      } else if (action.type === 'toolUse') {
        await this.runToolUseAction(action);
      } else {
        throw new Error(`Unknown action type: ${JSON.stringify(action)}`);
      }
      this.updateAction(actionId, {
        status: isStreaming ? 'running' : action.abortSignal.aborted ? 'aborted' : 'complete',
      });
    } catch (error) {
      if (action.abortSignal.aborted) {
        return;
      }
      this.updateAction(actionId, { status: 'failed', error: 'Action failed' });
      logger.error(`[${action.type}]:Action failed\n\n`, error);
      if (error instanceof ActionCommandError) {
        this.callbacks.onAlert?.({
          type: 'error',
          title: 'Command Failed',
          description: error.header,
          content: error.output,
        });
        throw error;
      }
    }
  }

  private async runToolUseAction(action: ActionState): Promise<void> {
    if (action.type !== 'toolUse') {
      unreachable('Expected tool use action');
    }
    const invocation: GhostbuildToolInvocation = action.parsedContent;
    const applyCompletedMutation = invocation.state === 'result' && isFileMutationTool(invocation.toolName);
    const shouldSendResult = invocation.state !== 'result';
    if (invocation.state === 'result' && !applyCompletedMutation) {
      return;
    }
    if (invocation.state === 'partial-call') {
      throw new Error('Tool call is still in progress');
    }

    try {
      await this.waitForWorkspaceReady();
      const container = await this.webcontainer;
      const result = await this.#scheduler.run(invocation.toolName, async () =>
        executeTool({
          invocation,
          container,
          abortSignal: action.abortSignal,
          onOutput: (output) => this.terminalOutput.set(output),
          workspace: this.callbacks.workspace,
          diagnostics: this.#diagnostics,
          deploymentValidation: this.#deploymentValidation,
          buildExecutor: this.callbacks.buildExecutor ?? createWebContainerBuildExecutor(container),
        }),
      );
      action.abortSignal.throwIfAborted();
      if (shouldSendResult) {
        this.callbacks.onToolCallComplete({
          result,
          toolCallId: invocation.toolCallId,
        });
      }
      if (invocation.state === 'call' && result.ok) {
        this.#lastSuccessfulToolCallKey = toolCallKey(invocation);
      }
      if (!result.ok) {
        throw new ToolReportedFailure(result.summary);
      }
    } catch (error) {
      if (action.abortSignal.aborted) {
        throw error;
      }
      if (error instanceof ToolReportedFailure) {
        throw error;
      }
      logger.error('Error on tool call', error);
      const result = toolFailure(boundedUnexpectedError(error, invocation.toolName));
      if (shouldSendResult) {
        this.callbacks.onToolCallComplete({
          result,
          toolCallId: invocation.toolCallId,
        });
      }
      throw error;
    }
  }

  private waitForWorkspaceReady(): Promise<unknown> {
    return this.callbacks.waitForWorkspaceReady?.() ?? waitForContainerBootState(ContainerBootState.READY);
  }
}

function boundedUnexpectedError(error: unknown, toolName: string): string {
  return boundedErrorMessage(
    error,
    `${toolName} failed with an unusually large internal error. The complete error was retained in developer logs.`,
  );
}

function toolCallKey(invocation: Pick<GhostbuildToolInvocation, 'toolName' | 'args'>): string {
  return `${invocation.toolName}:${JSON.stringify(invocation.args)}`;
}
