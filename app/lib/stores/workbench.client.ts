import { atom, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { EditorDocument, FileMap, ScrollPosition } from 'ghostbuild-agent/types';
import type { AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceClientChange,
  BuilderWorkspaceSyncEntry,
} from '~/agents/builder-workspace-types';
import { downloadProject } from '~/lib/download/download-project';
import { description } from './description';
import { EditorStore } from './editor';
import { FilesStore } from './files';
import { PreviewsStore } from './previews';
import { workbenchCurrentView } from './workbench-ui-state';

export type { WorkbenchViewType } from './workbench-ui-state';

type WorkspaceChangeListener = (changes: BuilderWorkspaceClientChange[]) => Promise<BuilderWorkspaceApplyResult>;

class WorkbenchStore {
  #previewsStore = new PreviewsStore();
  #filesStore = new FilesStore();
  #editorStore = new EditorStore();
  showWorkbench: WritableAtom<boolean> = import.meta.hot?.data.showWorkbench ?? atom(false);
  currentView = workbenchCurrentView;
  unsavedFiles: WritableAtom<Set<AbsolutePath>> = import.meta.hot?.data.unsavedFiles ?? atom(new Set<AbsolutePath>());

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.unsavedFiles = this.unsavedFiles;
      import.meta.hot.data.showWorkbench = this.showWorkbench;
    }
  }

  get followingStreamedCode() {
    return this.#editorStore.followingStreamedCode;
  }

  stopFollowingStreamedCode(): void {
    this.#editorStore.followingStreamedCode.set(false);
  }

  get previewState() {
    return this.#previewsStore.state;
  }

  get previews() {
    return this.#previewsStore.previews;
  }

  connectPreview(...args: Parameters<PreviewsStore['connect']>) {
    return this.#previewsStore.connect(...args);
  }

  updatePreview(...args: Parameters<PreviewsStore['update']>) {
    return this.#previewsStore.update(...args);
  }

  refreshPreview() {
    return this.#previewsStore.refresh();
  }

  requestPreview() {
    return this.#previewsStore.request();
  }

  cancelPreview() {
    return this.#previewsStore.cancel();
  }

  get files() {
    return this.#filesStore.files;
  }

  get userWrites() {
    return this.#filesStore.userWrites;
  }

  setWorkspaceChangeListener(listener: WorkspaceChangeListener | null): void {
    this.#filesStore.setWorkspaceChangeListener(listener);
  }

  clearWorkspaceChangeListener(listener: WorkspaceChangeListener): void {
    this.#filesStore.clearWorkspaceChangeListener(listener);
  }

  applyWorkspaceSyncEntries(entries: BuilderWorkspaceSyncEntry[]): void {
    this.#filesStore.applyWorkspaceSyncEntries(entries);
    this.setDocuments(this.#filesStore.files.get());
  }

  replaceWorkspaceSnapshot(entries: BuilderWorkspaceSyncEntry[]): void {
    this.#filesStore.replaceWorkspaceSnapshot(entries);
    this.unsavedFiles.set(new Set());
    this.setDocuments(this.#filesStore.files.get());
  }

  get currentDocument(): ReadableAtom<EditorDocument | undefined> {
    return this.#editorStore.currentDocument;
  }

  get selectedFile(): ReadableAtom<string | undefined> {
    return this.#editorStore.selectedFile;
  }

  setDocuments(files: FileMap): void {
    this.#editorStore.setDocuments(files, this.unsavedFiles.get());
    if (this.currentDocument.get() !== undefined) {
      return;
    }
    const preferredFiles = ['/home/project/src/routes/index.tsx', '/home/project/package.json'];
    const preferredFile = preferredFiles.find((filePath) => files[filePath as AbsolutePath]?.type === 'file');
    if (preferredFile) {
      this.setSelectedFile(preferredFile as AbsolutePath);
      return;
    }
    const firstFile = Object.entries(files).find(([, entry]) => entry?.type === 'file');
    this.setSelectedFile(firstFile?.[0] as AbsolutePath | undefined);
  }

  setCurrentDocumentContent(newContent: string): void {
    const filePath = this.currentDocument.get()?.filePath;
    if (!filePath) {
      return;
    }
    const originalContent = this.#filesStore.getFile(filePath)?.content;
    const unsavedChanges = originalContent !== undefined && originalContent !== newContent;
    this.#editorStore.updateFile(filePath, newContent);
    const next = new Set(this.unsavedFiles.get());
    if (unsavedChanges) {
      next.add(filePath);
    } else {
      next.delete(filePath);
    }
    this.unsavedFiles.set(next);
  }

  setCurrentDocumentScrollPosition(position: ScrollPosition): void {
    const document = this.currentDocument.get();
    if (document) {
      this.#editorStore.updateScrollPosition(document.filePath, position);
    }
  }

  setSelectedFile(filePath: AbsolutePath | undefined): void {
    this.#editorStore.setSelectedFile(filePath);
  }

  async saveFile(filePath: string): Promise<void> {
    const absolutePath = getAbsolutePath(filePath);
    const document = this.#editorStore.documents.get()[absolutePath];
    if (!document) {
      return;
    }
    await this.#filesStore.saveFile(absolutePath, document.value);
    const next = new Set(this.unsavedFiles.get());
    next.delete(absolutePath);
    this.unsavedFiles.set(next);
  }

  async saveCurrentDocument(): Promise<void> {
    const current = this.currentDocument.get();
    if (current) {
      await this.saveFile(current.filePath);
    }
  }

  resetCurrentDocument(): void {
    const current = this.currentDocument.get();
    const file = current && this.#filesStore.getFile(current.filePath);
    if (current && file) {
      this.setCurrentDocumentContent(file.content);
    }
  }

  getModifiedFiles() {
    return this.#filesStore.getModifiedFiles();
  }

  resetAllFileModifications(): void {
    this.#filesStore.resetFileModifications();
  }

  async downloadZip(): Promise<void> {
    await downloadProject(this.files.get(), description.value ?? 'project');
  }
}

export const workbenchStore = new WorkbenchStore();
