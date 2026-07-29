import type { WebContainer } from '@webcontainer/api';
import type { MapStore } from 'nanostores';
import type { EditorDocument, FileMap } from 'ghostbuild-agent/types';
import type { ActionCallbackData, ArtifactCallbackData } from 'ghostbuild-agent/message-parser';
import type { PartId } from 'ghostbuild-agent/partId.js';
import { path } from 'ghostbuild-agent/utils/path';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { unreachable } from 'ghostbuild-agent/utils/unreachable';
import type { AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { createSampler } from '~/utils/sampler';
import { ActionRunner, isActionStatusActive } from '~/lib/runtime/action-runner';

const logger = createScopedLogger('WorkbenchArtifacts');
const ACTION_STREAM_SAMPLE_MS = 100;

export interface ArtifactState {
  id: string;
  title: string;
  type?: string;
  closed: boolean;
  runner: ActionRunner;
}

type ArtifactUpdateState = Pick<ArtifactState, 'title' | 'closed'>;
type ActionStreamSampler = ((data: ActionCallbackData, isStreaming: boolean, generation: number) => void) & {
  cancel(): void;
};

export interface ArtifactWorkspace {
  getFiles(): FileMap;
  getSelectedFile(): string | undefined;
  getCurrentView(): 'code' | 'preview';
  isFollowingStreamedCode(): boolean;
  setSelectedFile(filePath: AbsolutePath): void;
  getEditorDocument(filePath: string): EditorDocument | undefined;
  updateEditorFile(filePath: string, content: string): void;
  resetFileModifications(): void;
  setGeneratedFileContent(filePath: string, content: string): void | Promise<void>;
  waitForWorkspaceReady?(): Promise<unknown> | undefined;
}

export class WorkbenchArtifactStore {
  #executionQueue = Promise.resolve();
  #actionGeneration = 0;
  #turnActive = true;
  #actionStreamSampler: ActionStreamSampler;

  constructor(
    private readonly webcontainer: Promise<WebContainer>,
    private readonly artifacts: MapStore<Record<PartId, ArtifactState>>,
    private readonly reloadedParts: Set<string>,
    private readonly workspace: ArtifactWorkspace,
  ) {
    this.#actionStreamSampler = createSampler((data: ActionCallbackData, isStreaming: boolean, generation: number) => {
      if (generation === this.#actionGeneration) {
        void this.#runAction(data, isStreaming, generation);
      }
    }, ACTION_STREAM_SAMPLE_MS);
  }

  scheduleToolInvocation(toolInvocation: GhostbuildToolInvocation, partId: PartId): void {
    if (!this.#turnActive || toolInvocation.state === 'partial-call') {
      return;
    }
    this.addArtifact({
      id: partId,
      partId,
      title: 'Editing files...',
    });
    const data = {
      artifactId: partId,
      partId,
      actionId: toolInvocation.toolCallId,
      action: {
        type: 'toolUse' as const,
        toolName: toolInvocation.toolName,
        parsedContent: toolInvocation,
        content: JSON.stringify(toolInvocation),
      },
    };
    this.addAction(data);
    this.runAction(data);
  }

  startActionTurn(): void {
    this.#turnActive = true;
  }

  abortAllActions(): void {
    this.#turnActive = false;
    this.#actionGeneration += 1;
    this.#actionStreamSampler.cancel();
    for (const artifact of Object.values(this.artifacts.get())) {
      for (const action of Object.values(artifact.runner.actions.get())) {
        if (isActionStatusActive(action.status)) {
          action.abort();
        }
      }
    }
  }

  addReloadedPart(partId: PartId): void {
    this.reloadedParts.add(partId);
  }

  isReloadedPart(partId: PartId): boolean {
    return this.reloadedParts.has(partId);
  }

  addArtifact({ partId, title, id, type }: ArtifactCallbackData): void {
    if (this.getArtifact(partId)) {
      return;
    }
    this.artifacts.setKey(partId, {
      id,
      title,
      closed: false,
      type,
      runner: new ActionRunner(this.webcontainer, {
        workspace: {
          hasFile: (filePath) => Boolean(this.workspace.getFiles()[filePath as AbsolutePath]),
          setGeneratedFileContent: (filePath, content) => this.workspace.setGeneratedFileContent(filePath, content),
        },
        waitForWorkspaceReady: () => this.workspace.waitForWorkspaceReady?.(),
      }),
    });
  }

  updateArtifact({ partId }: ArtifactCallbackData, state: Partial<ArtifactUpdateState>): void {
    const artifact = this.getArtifact(partId);
    if (artifact) {
      this.artifacts.setKey(partId, { ...artifact, ...state });
    }
  }

  addAction(data: ActionCallbackData): void {
    if (!this.#turnActive) {
      return;
    }
    this.#enqueue(() => this.#addAction(data), this.#actionGeneration);
  }

  runAction(data: ActionCallbackData, isStreaming = false): void {
    if (!this.#turnActive) {
      return;
    }
    const generation = this.#actionGeneration;
    if (isStreaming) {
      this.#actionStreamSampler(data, isStreaming, generation);
      return;
    }
    if (data.action.type === 'toolUse') {
      this.#enqueueDetached(() => this.#runAction(data, isStreaming, generation), generation);
      return;
    }
    this.#enqueue(() => this.#runAction(data, isStreaming, generation), generation);
  }

  getArtifact(partId: PartId | undefined): ArtifactState | undefined {
    return partId ? this.artifacts.get()[partId] : undefined;
  }

  #enqueue(callback: () => void | Promise<void>, generation: number): void {
    const execution = this.#executionQueue.then(async () => {
      if (generation !== this.#actionGeneration) {
        return;
      }
      await callback();
    });
    this.#executionQueue = execution.catch((error) => {
      logger.error('Artifact action failed', error);
    });
  }

  #enqueueDetached(callback: () => Promise<void>, generation: number): void {
    const started = this.#executionQueue.then(() => {
      if (generation !== this.#actionGeneration) {
        return;
      }
      void callback().catch((error) => logger.error('Detached tool action failed', error));
    });
    this.#executionQueue = started.catch((error) => {
      logger.error('Failed to start tool action', error);
    });
  }

  #addAction(data: ActionCallbackData): void {
    const artifact = this.getArtifact(data.partId);
    if (!artifact) {
      unreachable('Artifact not found');
    }
    artifact.runner.addAction(data);
  }

  async #runAction(data: ActionCallbackData, isStreaming: boolean, generation: number): Promise<void> {
    if (generation !== this.#actionGeneration) {
      return;
    }
    const artifact = this.getArtifact(data.partId);
    if (!artifact) {
      unreachable('Artifact not found');
    }
    const action = artifact.runner.actions.get()[data.actionId];
    if (this.isReloadedPart(data.partId)) {
      artifact.runner.updateAction(data.actionId, { executed: true, status: 'complete' });
      return;
    }
    if (!action || action.executed) {
      return;
    }
    if (data.action.type === 'file') {
      await this.#runFileAction(artifact, data, isStreaming, generation);
      return;
    }
    await artifact.runner.runAction(data, { isStreaming });
  }

  async #runFileAction(
    artifact: ArtifactState,
    data: ActionCallbackData,
    isStreaming: boolean,
    generation: number,
  ): Promise<void> {
    if (data.action.type !== 'file') {
      unreachable('Expected file action');
    }
    const container = await this.webcontainer;
    if (generation !== this.#actionGeneration) {
      return;
    }
    const fullPath = path.join(container.workdir, data.action.filePath);
    if (
      this.workspace.getSelectedFile() !== fullPath &&
      this.workspace.getCurrentView() === 'code' &&
      this.workspace.isFollowingStreamedCode()
    ) {
      this.workspace.setSelectedFile(fullPath as AbsolutePath);
    }
    if (!this.workspace.getEditorDocument(fullPath)) {
      await artifact.runner.runAction(data, { isStreaming });
      if (generation !== this.#actionGeneration) {
        return;
      }
    }
    this.workspace.updateEditorFile(fullPath, data.action.content.trimStart());
    if (!isStreaming) {
      await artifact.runner.runAction(data, { isStreaming });
      if (generation !== this.#actionGeneration) {
        return;
      }
      this.workspace.resetFileModifications();
    }
  }
}
