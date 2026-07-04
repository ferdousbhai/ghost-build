import { atom, map, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { EditorDocument, ScrollPosition } from 'ghostbuild-agent/types';
import { ActionRunner } from '~/lib/runtime/action-runner';
import type { ActionCallbackData, ArtifactCallbackData } from 'ghostbuild-agent/message-parser';
import { webcontainer } from '~/lib/webcontainer';
import type { ITerminal, TerminalInitializationOptions } from '~/types/terminal';
import { unreachable } from 'ghostbuild-agent/utils/unreachable';
import { EditorStore } from './editor';
import { FilesStore } from './files';
import type { FileMap } from 'ghostbuild-agent/types';
import type { AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { getAbsolutePath, getRelativePath } from 'ghostbuild-agent/utils/workDir';
import { PreviewsStore } from './previews';
import { TerminalStore } from './terminal';
import { path } from 'ghostbuild-agent/utils/path';
import { description } from './description';
import { createSampler } from '~/utils/sampler';
import type { ActionAlert } from '~/types/actions';
import type { WebContainer } from '@webcontainer/api';
import { withResolvers } from '~/utils/promises';
import type { Artifacts } from './artifacts';
import { WORK_DIR } from 'ghostbuild-agent/constants';
import { parsePartId, type PartId, type MessageId } from 'ghostbuild-agent/partId.js';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { generateReadmeContent } from '~/lib/download/readmeContent';
import { cursorRulesContent } from '~/lib/download/cursorRulesContent';
import type { GhostbuildToolName } from '~/lib/common/types';
import { isLocalSecretFilePath } from '~/utils/secretFiles';
import { isActionStatusActive } from '~/lib/runtime/action-runner';

const logger = createScopedLogger('WorkbenchStore');
const ACTION_STREAM_SAMPLE_MS = 100;
const WORKER_BUILD_TRIGGER_FILES = new Set([
  path.join(WORK_DIR, 'wrangler.jsonc'),
  path.join(WORK_DIR, 'src/server.ts'),
  path.join(WORK_DIR, 'src/workers-ai.shared.ts'),
]);
const WORKER_BUILD_TRIGGER_AGENT_DIR = path.join(WORK_DIR, 'src/agents');

function isWorkerBuildTriggerPath(filePath: string) {
  return (
    WORKER_BUILD_TRIGGER_FILES.has(filePath) ||
    filePath === WORKER_BUILD_TRIGGER_AGENT_DIR ||
    filePath.startsWith(`${WORKER_BUILD_TRIGGER_AGENT_DIR}/`)
  );
}

export interface ArtifactState {
  id: string;
  title: string;
  type?: string;
  closed: boolean;
  runner: ActionRunner;
}

type ArtifactUpdateState = Pick<ArtifactState, 'title' | 'closed'>;

export type WorkbenchViewType = 'code' | 'diff' | 'preview';

class WorkbenchStore {
  #previewsStore = new PreviewsStore(webcontainer);
  #filesStore = new FilesStore(webcontainer);
  #editorStore = new EditorStore(this.#filesStore);
  #terminalStore = new TerminalStore(webcontainer);
  #toolCalls: Map<string, PromiseWithResolvers<{ result: string }> & { done: boolean }> = new Map();

  #reloadedParts = import.meta.hot?.data.reloadedParts ?? new Set<string>();

  artifacts: Artifacts = import.meta.hot?.data.artifacts ?? map({});

  _lastChangedFile: number = 0;

  showWorkbench: WritableAtom<boolean> = import.meta.hot?.data.showWorkbench ?? atom(false);
  currentView: WritableAtom<WorkbenchViewType> = import.meta.hot?.data.currentView ?? atom('code');
  unsavedFiles: WritableAtom<Set<AbsolutePath>> = import.meta.hot?.data.unsavedFiles ?? atom(new Set<AbsolutePath>());
  actionAlert: WritableAtom<ActionAlert | undefined> =
    import.meta.hot?.data.actionAlert ?? atom<ActionAlert | undefined>(undefined);
  partIdList: PartId[] = [];
  #globalExecutionQueue = Promise.resolve();
  _toolCallResults: Map<MessageId, Array<{ partId: PartId; kind: 'success' | 'error'; toolName: GhostbuildToolName }>> =
    new Map();

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.artifacts = this.artifacts;
      import.meta.hot.data.unsavedFiles = this.unsavedFiles;
      import.meta.hot.data.showWorkbench = this.showWorkbench;
      import.meta.hot.data.currentView = this.currentView;
      import.meta.hot.data.actionAlert = this.actionAlert;
      import.meta.hot.data.reloadedParts = this.#reloadedParts;
    }
  }

  get followingStreamedCode() {
    return this.#editorStore.followingStreamedCode;
  }
  resumeFollowingStreamedCode() {
    this.#editorStore.followingStreamedCode.set(true);
  }
  stopFollowingStreamedCode() {
    const following = this.#editorStore.followingStreamedCode.get();
    if (following) {
      this.#editorStore.followingStreamedCode.set(false);
    }
  }

  get justChangedFiles(): boolean {
    const now = Date.now();
    const close = 300;
    return now - this._lastChangedFile < close;
  }
  setLastChangedFile(): void {
    this._lastChangedFile = Date.now();
  }

  addToExecutionQueue(callback: () => void | Promise<void>) {
    this.#globalExecutionQueue = this.#globalExecutionQueue.then(() => callback());
  }

  get previews() {
    return this.#previewsStore.previews;
  }

  setPreviewIframe(previewIndex: number, element: HTMLIFrameElement | null) {
    this.#previewsStore.previews.set(
      this.#previewsStore.previews
        .get()
        .map((preview, i) => (i === previewIndex ? { ...preview, iframe: element } : preview)),
    );
  }

  requestAnyScreenshot(timeout = 30000): Promise<string> {
    return this.#previewsStore.requestAnyScreenshot(timeout);
  }

  requestScreenshot(previewIndex: number): Promise<string> {
    return this.#previewsStore.requestScreenshot(previewIndex);
  }

  startProxy(sourcePort: number) {
    return this.#previewsStore.startProxy(sourcePort);
  }

  stopProxy(proxyPort: number) {
    return this.#previewsStore.stopProxy(proxyPort);
  }

  #getOrCreateToolCall(toolCallId: string) {
    let resolvers = this.#toolCalls.get(toolCallId);
    if (!resolvers) {
      resolvers = {
        ...withResolvers<{ result: string }>(),
        done: false,
      };
      this.#toolCalls.set(toolCallId, resolvers);
    }
    return resolvers;
  }

  get files() {
    return this.#filesStore.files;
  }

  get userWrites() {
    return this.#filesStore.userWrites;
  }

  prewarmWorkdir(container: WebContainer) {
    return this.#filesStore.prewarmWorkdir(container);
  }

  waitOnToolCall(toolCallId: string): Promise<{ result: string }> {
    return this.#getOrCreateToolCall(toolCallId).promise;
  }

  get currentDocument(): ReadableAtom<EditorDocument | undefined> {
    return this.#editorStore.currentDocument;
  }

  get selectedFile(): ReadableAtom<string | undefined> {
    return this.#editorStore.selectedFile;
  }

  get firstArtifact(): ArtifactState | undefined {
    return this.#getArtifact(this.partIdList[0]);
  }

  get filesCount(): number {
    return this.#filesStore.filesCount;
  }

  get showTerminal() {
    return this.#terminalStore.showTerminal;
  }
  get appShellTerminal() {
    return this.#terminalStore.appShellTerminal;
  }

  get alert() {
    return this.actionAlert;
  }
  clearAlert() {
    this.actionAlert.set(undefined);
  }

  toggleTerminal(value?: boolean) {
    this.#terminalStore.toggleTerminal(value);
  }

  attachTerminal(terminal: ITerminal) {
    this.#terminalStore.attachTerminal(terminal);
  }
  attachAppShellTerminal(terminal: ITerminal) {
    this.#terminalStore.attachAppShellTerminal(terminal);
  }
  attachDeployTerminal(terminal: ITerminal, options?: TerminalInitializationOptions) {
    this.#terminalStore.attachDeployTerminal(terminal, options);
  }

  onTerminalResize(cols: number, rows: number) {
    this.#terminalStore.onTerminalResize(cols, rows);
  }

  setDocuments(files: FileMap) {
    this.#editorStore.setDocuments(files);

    if (this.#filesStore.filesCount > 0 && this.currentDocument.get() === undefined) {
      const preferredFiles = ['/home/project/src/routes/index.tsx', '/home/project/package.json'];
      const preferredFile = preferredFiles.find((filePath) => files[filePath as AbsolutePath]?.type === 'file');
      if (preferredFile) {
        this.setSelectedFile(preferredFile as AbsolutePath);
        return;
      }
      // we find the first file and select it
      for (const [filePath, dirent] of Object.entries(files)) {
        if (dirent?.type === 'file') {
          // Note -- cast is safe since `FileMap` is a record of `AbsolutePath` -> `Dirent`,
          // but `Object.entries` loses the type information.
          this.setSelectedFile(filePath as AbsolutePath);
          break;
        }
      }
    }
  }

  setShowWorkbench(show: boolean) {
    this.showWorkbench.set(show);
  }

  setCurrentDocumentContent(newContent: string) {
    const currentDocument = this.currentDocument.get();
    const filePath = currentDocument?.filePath;

    if (!filePath) {
      return;
    }

    const originalContent = this.#filesStore.getFile(filePath)?.content;
    const unsavedChanges = originalContent !== undefined && originalContent !== newContent;

    this.#editorStore.updateFile(filePath, newContent);

    const previousUnsavedFiles = this.unsavedFiles.get();
    const isAlreadyMarkedUnsaved = previousUnsavedFiles.has(filePath);

    if (unsavedChanges === isAlreadyMarkedUnsaved) {
      return;
    }

    const newUnsavedFiles = new Set(previousUnsavedFiles);
    newUnsavedFiles[unsavedChanges ? 'add' : 'delete'](filePath);

    this.unsavedFiles.set(newUnsavedFiles);
  }

  setCurrentDocumentScrollPosition(position: ScrollPosition) {
    const editorDocument = this.currentDocument.get();

    if (!editorDocument) {
      return;
    }

    const { filePath } = editorDocument;

    this.#editorStore.updateScrollPosition(filePath, position);
  }

  setSelectedFile(filePath: AbsolutePath | undefined) {
    this.setLastChangedFile();
    this.#editorStore.setSelectedFile(filePath);
  }

  async saveFile(filePath: string) {
    const documents = this.#editorStore.documents.get();
    const absPath = getAbsolutePath(filePath);
    const document = documents[absPath];

    if (document === undefined) {
      return;
    }

    await this.#filesStore.saveFile(absPath, document.value);

    const newUnsavedFiles = new Set(this.unsavedFiles.get());
    newUnsavedFiles.delete(absPath);

    this.unsavedFiles.set(newUnsavedFiles);
    if (isWorkerBuildTriggerPath(filePath)) {
      await this.#terminalStore.buildWorker(true);
    }
  }

  async saveCurrentDocument() {
    const currentDocument = this.currentDocument.get();

    if (currentDocument === undefined) {
      return;
    }

    await this.saveFile(currentDocument.filePath);
  }

  resetCurrentDocument() {
    const currentDocument = this.currentDocument.get();

    if (currentDocument === undefined) {
      return;
    }

    const { filePath } = currentDocument;
    const file = this.#filesStore.getFile(filePath);

    if (!file) {
      return;
    }

    this.setCurrentDocumentContent(file.content);
  }

  async saveAllFiles() {
    for (const filePath of this.unsavedFiles.get()) {
      await this.saveFile(filePath);
    }
  }

  getModifiedFiles() {
    return this.#filesStore.getModifiedFiles();
  }

  resetAllFileModifications() {
    this.#filesStore.resetFileModifications();
  }

  abortAllActions() {
    // Update all running tools to aborted status
    const artifacts = this.artifacts.get();
    for (const artifact of Object.values(artifacts)) {
      const actions = artifact.runner.actions.get();
      for (const [actionId, action] of Object.entries(actions)) {
        if (isActionStatusActive(action.status)) {
          artifact.runner.updateAction(actionId, {
            ...action,
            status: 'aborted',
          });
        }
      }
    }
  }

  addReloadedPart(partId: PartId) {
    this.#reloadedParts.add(partId);
  }

  isReloadedPart(partId: PartId) {
    return this.#reloadedParts.has(partId);
  }

  addArtifact({ partId, title, id, type }: ArtifactCallbackData) {
    const messageId = parsePartId(partId).messageId;
    if (!this._toolCallResults.has(messageId)) {
      this._toolCallResults.set(messageId, []);
    }
    const artifact = this.#getArtifact(partId);

    if (artifact) {
      return;
    }

    if (!this.partIdList.includes(partId)) {
      this.partIdList.push(partId);
    }

    this.artifacts.setKey(partId, {
      id,
      title,
      closed: false,
      type,
      runner: new ActionRunner(webcontainer, {
        onAlert: (alert) => {
          if (this.#reloadedParts.has(partId)) {
            return;
          }

          this.actionAlert.set(alert);
        },
        onToolCallComplete: ({ kind, result, toolCallId, toolName }) => {
          const toolCallPromise = this.#toolCalls.get(toolCallId);
          if (!toolCallPromise) {
            logger.error('Tool call promise not found');
            return;
          }
          const messageId = parsePartId(partId).messageId;
          const toolCallResults = this._toolCallResults.get(messageId);
          if (!toolCallResults) {
            logger.error('Tool call results not found');
            toolCallPromise.resolve({ result });
            return;
          }
          toolCallResults.push({ partId, kind, toolName });
          toolCallPromise.resolve({ result });
        },
      }),
    });
  }

  updateArtifact({ partId }: ArtifactCallbackData, state: Partial<ArtifactUpdateState>) {
    const artifact = this.#getArtifact(partId);

    if (!artifact) {
      return;
    }

    this.artifacts.setKey(partId, { ...artifact, ...state });
  }
  addAction(data: ActionCallbackData) {
    this.addToExecutionQueue(() => this._addAction(data));
  }
  _addAction(data: ActionCallbackData) {
    const { partId } = data;

    const artifact = this.#getArtifact(partId);

    if (!artifact) {
      unreachable('Artifact not found');
    }

    return artifact.runner.addAction(data);
  }

  runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    if (isStreaming) {
      this.actionStreamSampler(data, isStreaming);
      return;
    }

    this.addToExecutionQueue(() => this._runAction(data, isStreaming));
  }
  async _runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    const { partId } = data;

    const artifact = this.#getArtifact(partId);

    if (!artifact) {
      unreachable('Artifact not found');
    }

    const action = artifact.runner.actions.get()[data.actionId];

    // Skip running actions if they are part of a reloaded message
    if (this.isReloadedPart(partId)) {
      artifact.runner.updateAction(data.actionId, { executed: true, status: 'complete' });
      return;
    }

    if (!action || action.executed) {
      return;
    }

    if (data.action.type === 'file') {
      const wc = await webcontainer;
      const fullPath = path.join(wc.workdir, data.action.filePath);

      if (this.selectedFile.value !== fullPath) {
        // Consider focusing the streaming tab so user can see code flowing in.
        const selectedView = workbenchStore.currentView.value;
        const followingStreamedCode = workbenchStore.followingStreamedCode.get();
        if (selectedView === 'code' && followingStreamedCode) {
          this.setSelectedFile(fullPath as AbsolutePath);
        }
      }

      const doc = this.#editorStore.documents.get()[fullPath];

      if (!doc) {
        await artifact.runner.runAction(data, { isStreaming: !!isStreaming });
      }

      // Where does this initial newline come from? The tool parsing incorrectly?
      const newContent = data.action.content.trimStart();

      this.#editorStore.updateFile(fullPath, newContent);

      if (!isStreaming) {
        await artifact.runner.runAction(data, { isStreaming: !!isStreaming });
        this.resetAllFileModifications();
      }

      return;
    }

    if (data.action.type === 'toolUse') {
      this.#getOrCreateToolCall(data.action.parsedContent.toolCallId);
    }

    await artifact.runner.runAction(data, { isStreaming: !!isStreaming });
  }

  actionStreamSampler = createSampler(
    (data: ActionCallbackData, isStreaming: boolean = false) => this._runAction(data, isStreaming),
    ACTION_STREAM_SAMPLE_MS,
  );

  #getArtifact(partId: PartId): ArtifactState | undefined {
    const artifacts = this.artifacts.get();
    return artifacts[partId];
  }

  async downloadZip() {
    const [{ default: JSZip }, { default: fileSaver }] = await Promise.all([import('jszip'), import('file-saver')]);
    const zip = new JSZip();
    const files = this.files.get();

    // Get the project name from the description input, or use a default name
    const projectName = (description.value ?? 'project').toLocaleLowerCase().split(' ').join('_');

    let hasReadme = false;
    let hasCursorRules = false;

    for (const [filePath, dirent] of Object.entries(files)) {
      if (dirent?.type === 'file' && !dirent.isBinary) {
        const relativePath = getRelativePath(filePath);
        if (isLocalSecretFilePath(relativePath)) {
          continue;
        }

        zip.file(relativePath, dirent.content, { createFolders: true });
        hasReadme ||= relativePath.toLowerCase() === 'readme.md';
        hasCursorRules ||= relativePath === '.cursor/rules/cloudflare_rules.mdc';
      }
    }

    // Add a README.md file specific to Ghostbuild here, but don't clobber an existing one
    const readmeContent = generateReadmeContent(description.value ?? 'project');
    const readmePath = hasReadme ? `GHOSTBUILD_README.md` : 'README.md';
    zip.file(readmePath, readmeContent);
    if (!hasCursorRules) {
      zip.file('.cursor/rules/cloudflare_rules.mdc', cursorRulesContent);
    }
    // Generate the zip file and save it
    const content = await zip.generateAsync({ type: 'blob' });
    fileSaver.saveAs(content, `${projectName}.zip`);
  }

  isDefaultPreviewRunning() {
    const DEFAULT_PREVIEW_PORT = 5173;
    const previews = this.previews.get();
    return previews.some((preview) => preview.port === DEFAULT_PREVIEW_PORT);
  }
}

export const workbenchStore = new WorkbenchStore();
