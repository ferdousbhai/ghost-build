import type { WebContainer } from '@webcontainer/api';
import { map } from 'nanostores';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { unreachable } from 'ghostbuild-agent/utils/unreachable';
import type { ActionCallbackData } from 'ghostbuild-agent/message-parser';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { runStreamedFileAction } from './action-runner/file-tools';
import type { ActionRunnerWorkspace, ActionsMap, ActionState, ActionStateUpdate } from './action-runner/types';
import { ContainerBootState, waitForContainerBootState } from '~/lib/stores/containerBootState';

export { isActionStatusActive } from './action-runner/types';
export type { ActionState, ActionStatus } from './action-runner/types';

const logger = createScopedLogger('ActionRunner');

export class ActionRunner {
  #currentExecution: Promise<void> = Promise.resolve();

  readonly actions: ActionsMap = map({});

  constructor(
    private readonly webcontainer: Promise<WebContainer>,
    private readonly callbacks: {
      workspace: ActionRunnerWorkspace;
      waitForWorkspaceReady?: () => Promise<unknown> | undefined;
    },
  ) {}

  addAction(data: ActionCallbackData): void {
    const { actionId } = data;
    const existingAction = this.actions.get()[actionId];
    if (existingAction) {
      if (actionChanged(existingAction, data.action)) {
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
    if (action.type === 'toolUse' && action.parsedContent.state !== 'result') {
      return;
    }
    if (action.executed || (args.isStreaming && action.type !== 'file')) {
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
      } else if (action.type !== 'toolUse') {
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
    }
  }

  private waitForWorkspaceReady(): Promise<unknown> {
    return this.callbacks.waitForWorkspaceReady?.() ?? waitForContainerBootState(ContainerBootState.READY);
  }
}

function actionChanged(existing: ActionState, next: ActionCallbackData['action']): boolean {
  if (existing.type !== next.type || existing.content !== next.content) {
    return true;
  }
  return (
    existing.type === 'toolUse' &&
    next.type === 'toolUse' &&
    JSON.stringify(existing.parsedContent) !== JSON.stringify(next.parsedContent)
  );
}
