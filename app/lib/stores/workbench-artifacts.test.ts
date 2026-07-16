import { atom, map, type MapStore } from 'nanostores';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { WebContainer } from '@webcontainer/api';
import { makePartId, type PartId } from 'ghostbuild-agent/partId';
import type { FileMap } from 'ghostbuild-agent/types';
import type { ActionCallbackData } from 'ghostbuild-agent/message-parser';
import { getAbsolutePath, getRelativePath } from 'ghostbuild-agent/utils/workDir';
import type { ActionRunner } from '~/lib/runtime/action-runner';
import type { ActionState } from '~/lib/runtime/action-runner/types';
import type { ActionAlert } from '~/types/actions';
import {
  ToolCallAbortedError,
  WorkbenchArtifactStore,
  type ArtifactState,
  type ArtifactWorkspace,
} from './workbench-artifacts';

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkbenchArtifactStore abort lifecycle', () => {
  test('invokes the action abort closure for active actions', () => {
    const abort = vi.fn();
    const partId = makePartId('message', 0);
    const runner = {
      actions: map({ running: { status: 'running', abort } as unknown as ActionState }),
    } as unknown as ActionRunner;
    const artifacts = map<Record<typeof partId, ArtifactState>>({
      [partId]: { id: 'artifact', title: 'Artifact', closed: false, runner },
    });
    const store = new WorkbenchArtifactStore(
      Promise.resolve({} as WebContainer),
      artifacts,
      atom<ActionAlert | undefined>(),
      new Set(),
      {
        getFiles: () => ({}) as FileMap,
        getPreviewPort: () => undefined,
        getSelectedFile: () => undefined,
        getCurrentView: () => 'code',
        isFollowingStreamedCode: () => false,
        setSelectedFile: vi.fn(),
        getEditorDocument: () => undefined,
        updateEditorFile: vi.fn(),
        resetFileModifications: vi.fn(),
        setGeneratedFileContent: vi.fn(),
      },
    );

    store.abortAllActions();

    expect(abort).toHaveBeenCalledOnce();
  });

  test('rejects pending and late tool-call waiters until the next turn starts', async () => {
    const store = createStore(map<Record<PartId, ArtifactState>>({}));
    const first = store.waitOnToolCall('first');
    const second = store.waitOnToolCall('second');

    store.abortAllActions();

    await expect(first).rejects.toEqual(new ToolCallAbortedError('first'));
    await expect(second).rejects.toEqual(new ToolCallAbortedError('second'));

    await expect(store.waitOnToolCall('late')).rejects.toEqual(new ToolCallAbortedError('late'));

    store.startActionTurn();
    const replacement = store.waitOnToolCall('next-turn');
    let replacementRejected = false;
    void replacement.catch(() => {
      replacementRejected = true;
    });
    await Promise.resolve();
    expect(replacementRejected).toBe(false);
    store.abortAllActions();
    await expect(replacement).rejects.toEqual(new ToolCallAbortedError('next-turn'));
  });

  test('invalidates file actions queued before abort', async () => {
    const partId = makePartId('message', 0);
    const updateEditorFile = vi.fn();
    const writeFile = vi.fn();
    const store = createStore(map<Record<PartId, ArtifactState>>({}), {
      container: {
        workdir: '/home/project',
        fs: { mkdir: vi.fn(), writeFile },
      } as unknown as WebContainer,
      workspace: { updateEditorFile },
    });
    const action = fileAction(partId, 'queued content');
    store.addArtifact({ partId, id: 'artifact', title: 'Artifact' });

    store.addAction(action);
    store.runAction(action);
    store.abortAllActions();
    await flushTasks();

    expect(writeFile).not.toHaveBeenCalled();
    expect(updateEditorFile).not.toHaveBeenCalled();
  });

  test('cancels a trailing sampled file update on abort', async () => {
    vi.useFakeTimers();
    const partId = makePartId('message', 0);
    const updateEditorFile = vi.fn();
    const store = createStore(map<Record<PartId, ArtifactState>>({}), {
      container: { workdir: '/home/project' } as WebContainer,
      workspace: {
        getEditorDocument: () => ({
          filePath: getAbsolutePath('src/app.ts'),
          value: 'existing',
          isBinary: false,
        }),
        updateEditorFile,
      },
    });
    const first = fileAction(partId, 'first');
    const trailing = fileAction(partId, 'trailing');
    store.addArtifact({ partId, id: 'artifact', title: 'Artifact' });
    store.addAction(first);
    await flushMicrotasks();

    store.runAction(first, true);
    await flushMicrotasks();
    expect(updateEditorFile).toHaveBeenCalledOnce();
    updateEditorFile.mockClear();

    store.runAction(trailing, true);
    store.abortAllActions();
    await vi.advanceTimersByTimeAsync(200);

    expect(updateEditorFile).not.toHaveBeenCalled();
  });
});

function createStore(
  artifacts: MapStore<Record<PartId, ArtifactState>>,
  options: { container?: WebContainer; workspace?: Partial<ArtifactWorkspace> } = {},
) {
  const workspace: ArtifactWorkspace = {
    getFiles: () => ({}) as FileMap,
    getPreviewPort: () => undefined,
    getSelectedFile: () => undefined,
    getCurrentView: () => 'code',
    isFollowingStreamedCode: () => false,
    setSelectedFile: vi.fn(),
    getEditorDocument: () => undefined,
    updateEditorFile: vi.fn(),
    resetFileModifications: vi.fn(),
    setGeneratedFileContent: vi.fn(),
    ...options.workspace,
  };
  return new WorkbenchArtifactStore(
    Promise.resolve(options.container ?? ({} as WebContainer)),
    artifacts,
    atom<ActionAlert | undefined>(),
    new Set(),
    workspace,
  );
}

function fileAction(partId: PartId, content: string): ActionCallbackData {
  return {
    artifactId: 'artifact',
    partId,
    actionId: 'file-action',
    action: { type: 'file', filePath: getRelativePath('/home/project/src/app.ts'), content },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
