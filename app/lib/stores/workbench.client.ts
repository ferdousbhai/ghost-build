import { atom, map, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { EditorDocument, ScrollPosition } from 'ghostbuild-agent/types';
import type { ActionCallbackData, ArtifactCallbackData } from 'ghostbuild-agent/message-parser';
import { webcontainer } from '~/lib/webcontainer';
import type { ITerminal, TerminalInitializationOptions } from '~/types/terminal';
import { EditorStore } from './editor';
import { FilesStore } from './files';
import type { FileMap } from 'ghostbuild-agent/types';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import type { AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { PreviewsStore } from './previews';
import { TerminalStore } from './terminal';
import { description } from './description';
import type { WebContainer } from '@webcontainer/api';
import type { Artifacts } from './artifacts';
import type { PartId } from 'ghostbuild-agent/partId.js';
import { WorkbenchArtifactStore, type ArtifactState } from './workbench-artifacts';
import { downloadProject } from '~/lib/download/download-project';
import { isWorkerBuildTriggerPath } from './worker-build-trigger';
import { workbenchActionAlert, workbenchCurrentView } from './workbench-ui-state';
import type { BuilderWorkspaceClientChange, BuilderWorkspaceSyncEntry } from '~/agents/builder-workspace-types';

export type { WorkbenchViewType } from './workbench-ui-state';

class WorkbenchStore {
  #previewsStore = new PreviewsStore(webcontainer);
  #filesStore = new FilesStore(webcontainer);
  #editorStore = new EditorStore();
  #terminalStore = new TerminalStore(webcontainer);
  #reloadedParts = import.meta.hot?.data.reloadedParts ?? new Set<string>();
  #artifactStore: WorkbenchArtifactStore;
  #workspaceReadyWaiter: (() => Promise<unknown>) | null = null;

  artifacts: Artifacts = import.meta.hot?.data.artifacts ?? map({});

  showWorkbench: WritableAtom<boolean> = import.meta.hot?.data.showWorkbench ?? atom(false);
  currentView = workbenchCurrentView;
  unsavedFiles: WritableAtom<Set<AbsolutePath>> = import.meta.hot?.data.unsavedFiles ?? atom(new Set<AbsolutePath>());
  actionAlert = workbenchActionAlert;

  constructor() {
    this.#artifactStore = new WorkbenchArtifactStore(
      webcontainer,
      this.artifacts,
      this.actionAlert,
      this.#reloadedParts,
      {
        getFiles: () => this.#filesStore.files.get(),
        getRecentFileWrites: () => this.#filesStore.userWrites,
        getPreviewPort: () => this.#previewsStore.previews.get().find((preview) => preview.ready)?.port,
        getSelectedFile: () => this.#editorStore.selectedFile.get(),
        getCurrentView: () => this.currentView.get(),
        isFollowingStreamedCode: () => this.#editorStore.followingStreamedCode.get(),
        setSelectedFile: (filePath) => this.setSelectedFile(filePath),
        getEditorDocument: (filePath) => this.#editorStore.documents.get()[filePath],
        updateEditorFile: (filePath, content) => this.#editorStore.updateFile(filePath, content),
        resetFileModifications: () => this.resetAllFileModifications(),
        setGeneratedFileContent: (filePath, content) => this.setGeneratedFileContent(filePath, content),
        waitForWorkspaceReady: () => this.#workspaceReadyWaiter?.(),
      },
    );
    if (import.meta.hot) {
      import.meta.hot.data.artifacts = this.artifacts;
      import.meta.hot.data.unsavedFiles = this.unsavedFiles;
      import.meta.hot.data.showWorkbench = this.showWorkbench;
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

  get previews() {
    return this.#previewsStore.previews;
  }

  setPreviewIframe(previewPort: number, element: HTMLIFrameElement | null) {
    this.#previewsStore.setPreviewIframe(previewPort, element);
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

  trackExternalPreview(proxyPort: number, previewId: string) {
    this.#previewsStore.trackExternalPreview(proxyPort, previewId);
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

  setWorkspaceChangeListener(listener: ((changes: BuilderWorkspaceClientChange[]) => Promise<void>) | null): void {
    this.#filesStore.setWorkspaceChangeListener(listener);
  }

  clearWorkspaceChangeListener(listener: (changes: BuilderWorkspaceClientChange[]) => Promise<void>): void {
    this.#filesStore.clearWorkspaceChangeListener(listener);
  }

  setWorkspaceReadyWaiter(waiter: () => Promise<unknown>): void {
    this.#workspaceReadyWaiter = waiter;
  }

  clearWorkspaceReadyWaiter(waiter: () => Promise<unknown>): void {
    if (this.#workspaceReadyWaiter === waiter) {
      this.#workspaceReadyWaiter = null;
    }
  }

  async applyWorkspaceSyncEntries(entries: BuilderWorkspaceSyncEntry[]): Promise<void> {
    await this.#filesStore.applyWorkspaceSyncEntries(entries);
    this.#editorStore.setDocuments(this.#filesStore.files.get(), this.unsavedFiles.get());
  }

  async replaceWorkspaceSnapshot(
    entries: BuilderWorkspaceSyncEntry[],
    preservedPaths = new Set<string>(),
  ): Promise<void> {
    await this.#filesStore.replaceWorkspaceSnapshot(entries, preservedPaths);
    this.#editorStore.setDocuments(this.#filesStore.files.get(), this.unsavedFiles.get());
  }

  flushFileEvents() {
    return this.#filesStore.flushFileEvents();
  }

  waitOnToolCall(toolCallId: string) {
    return this.#artifactStore.waitOnToolCall(toolCallId);
  }

  runToolInvocation(toolInvocation: GhostbuildToolInvocation) {
    return this.#artifactStore.runToolInvocation(toolInvocation);
  }

  scheduleToolInvocation(toolInvocation: GhostbuildToolInvocation, partId?: PartId): void {
    this.#artifactStore.scheduleToolInvocation(toolInvocation, partId);
  }

  get currentDocument(): ReadableAtom<EditorDocument | undefined> {
    return this.#editorStore.currentDocument;
  }

  get selectedFile(): ReadableAtom<string | undefined> {
    return this.#editorStore.selectedFile;
  }

  get showTerminal() {
    return this.#terminalStore.showTerminal;
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
  attachAppShellTerminal(terminal: ITerminal, options?: TerminalInitializationOptions) {
    this.#terminalStore.attachAppShellTerminal(terminal, options);
  }
  stopAppPreviewServer() {
    return this.#terminalStore.stopAppPreviewServer();
  }
  restartAppPreviewServer(command?: string) {
    return this.#terminalStore.restartAppPreviewServer(command);
  }
  attachDeployTerminal(terminal: ITerminal, options?: TerminalInitializationOptions) {
    this.#terminalStore.attachDeployTerminal(terminal, options);
  }

  onTerminalResize(cols: number, rows: number) {
    this.#terminalStore.onTerminalResize(cols, rows);
  }

  setDocuments(files: FileMap) {
    this.#editorStore.setDocuments(files, this.unsavedFiles.get());

    if (this.currentDocument.get() === undefined) {
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

  async setGeneratedFileContent(filePath: string, content: string): Promise<void> {
    const absPath = getAbsolutePath(filePath);

    await this.#filesStore.setGeneratedFile(absPath, content);
    this.#editorStore.setDocuments(this.#filesStore.files.get(), this.unsavedFiles.get());
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

  getModifiedFiles() {
    return this.#filesStore.getModifiedFiles();
  }

  resetAllFileModifications() {
    this.#filesStore.resetFileModifications();
  }

  abortAllActions() {
    this.#artifactStore.abortAllActions();
  }

  startActionTurn() {
    this.#artifactStore.startActionTurn();
  }

  addReloadedPart(partId: PartId) {
    this.#artifactStore.addReloadedPart(partId);
  }

  addArtifact(data: ArtifactCallbackData) {
    this.#artifactStore.addArtifact(data);
  }

  updateArtifact(data: ArtifactCallbackData, state: Partial<Pick<ArtifactState, 'title' | 'closed'>>) {
    this.#artifactStore.updateArtifact(data, state);
  }

  addAction(data: ActionCallbackData) {
    this.#artifactStore.addAction(data);
  }

  runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    this.#artifactStore.runAction(data, isStreaming);
  }

  async downloadZip() {
    await downloadProject(this.files.get(), description.value ?? 'project');
  }
}

export const workbenchStore = new WorkbenchStore();
