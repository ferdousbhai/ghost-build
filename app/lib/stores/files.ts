import type { IFSWatcher, WebContainer } from '@webcontainer/api';
import { map, type MapStore } from 'nanostores';
import { path } from 'ghostbuild-agent/utils/path';
import { bufferWatchEvents } from '~/utils/buffer';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { unreachable } from 'ghostbuild-agent/utils/unreachable';
import { getAbsolutePath, type AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import type { File, FileMap } from 'ghostbuild-agent/types';
import { assertNotLocalSecretFilePath, isManagedWebContainerNpmrc } from '~/utils/secretFiles';
import { assertValidGeneratedPackageJson } from '~/utils/generatedPackageManifest';
import {
  ensureParentFolders,
  getLocalSecretRootPath,
  isExcludedProjectPath,
  normalizeWatcherPath,
  reconcileFileMap,
  reconcileWatchedPaths,
} from './file-map-operations';
import { incrementFileUpdateCounter } from './fileUpdateCounter';
import { ContainerBootState, waitForContainerBootState } from './containerBootState';
import type { BuilderWorkspaceClientChange, BuilderWorkspaceSyncEntry } from '~/agents/builder-workspace-types';

const logger = createScopedLogger('FilesStore');

export class FilesStore {
  #webcontainer: Promise<WebContainer>;
  #watchEvents = bufferWatchEvents<WatcherEvent>(FILE_EVENTS_DEBOUNCE_MS, this.#processEventBuffer.bind(this));
  #fileWatchers = new Map<string, IFSWatcher>();
  #watcherRefresh: Promise<void> = Promise.resolve();

  /**
   * @note Keeps track all modified files with their original content since the last user message.
   * Needs to be reset when the user sends another message and all changes have to be submitted
   * for the model to be aware of the changes.
   */
  #modifiedFiles: Map<AbsolutePath, string> = import.meta.hot?.data.modifiedFiles ?? new Map();

  /**
   * Map of files that matches the state of WebContainer.
   */
  files: MapStore<FileMap> = import.meta.hot?.data.files ?? map({});
  userWrites: Map<AbsolutePath, number> = import.meta.hot?.data.userWrites ?? new Map();
  #workspaceChangeListener: ((changes: BuilderWorkspaceClientChange[]) => Promise<void>) | null = null;

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;

    if (import.meta.hot) {
      import.meta.hot.data.files = this.files;
      import.meta.hot.data.modifiedFiles = this.#modifiedFiles;
      import.meta.hot.data.userWrites = this.userWrites;
      import.meta.hot.dispose(() => this.#closeFileWatchers());
    }

    void this.#init().catch((error) => logger.error('Failed to initialize file watching', error));
  }

  getFile(filePath: AbsolutePath) {
    const dirent = this.files.get()[filePath];

    if (dirent?.type !== 'file') {
      return undefined;
    }

    return dirent;
  }

  getModifiedFiles() {
    const modifiedFiles: { [path: string]: File } = {};
    let hasModifiedFiles = false;

    for (const [filePath, originalContent] of this.#modifiedFiles) {
      const file = this.files.get()[filePath];

      if (file?.type !== 'file') {
        continue;
      }

      if (file.content === originalContent) {
        continue;
      }

      modifiedFiles[filePath] = file;
      hasModifiedFiles = true;
    }

    return hasModifiedFiles ? modifiedFiles : undefined;
  }

  resetFileModifications() {
    this.#modifiedFiles.clear();
  }

  async saveFile(filePath: AbsolutePath, content: string) {
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = path.relative(webcontainer.workdir, filePath);

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, write '${relativePath}'`);
      }

      assertNotLocalSecretFilePath(relativePath);

      const oldContent = this.getFile(filePath)?.content;

      if (oldContent === undefined) {
        unreachable('Expected content to be defined');
      }

      assertValidGeneratedPackageJson(relativePath, content);
      await webcontainer.fs.writeFile(relativePath, content);

      if (!this.#modifiedFiles.has(filePath)) {
        this.#modifiedFiles.set(filePath, oldContent);
      }

      // we immediately update the file and don't rely on the `change` event coming from the watcher
      this.files.setKey(filePath, { type: 'file', content, isBinary: false });
      this.userWrites.set(filePath, Date.now());

      logger.info('File updated');
      await this.#notifyWorkspaceWrite(filePath, content);
    } catch (error) {
      logger.error('Failed to update file content\n\n', error);

      throw error;
    }
  }

  async #init() {
    const webcontainer = await this.#webcontainer;
    await waitForContainerBootState(ContainerBootState.READY);
    await this.#refreshFileWatchers(webcontainer);
  }

  async prewarmWorkdir(container: WebContainer) {
    await reconcileFileMap(container, this.files);
  }

  setWorkspaceChangeListener(listener: ((changes: BuilderWorkspaceClientChange[]) => Promise<void>) | null): void {
    this.#workspaceChangeListener = listener;
  }

  clearWorkspaceChangeListener(listener: (changes: BuilderWorkspaceClientChange[]) => Promise<void>): void {
    if (this.#workspaceChangeListener === listener) {
      this.#workspaceChangeListener = null;
    }
  }

  async applyWorkspaceSyncEntries(entries: BuilderWorkspaceSyncEntry[]): Promise<void> {
    const container = await this.#webcontainer;
    for (const entry of entries) {
      const relativePath = path.relative(container.workdir, entry.path);
      if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
        throw new Error(`Invalid server workspace path: ${entry.path}`);
      }
      if (entry.kind === 'delete') {
        await container.fs.rm(relativePath, { recursive: true, force: true });
        this.#removeTrackedPath(relativePath);
        continue;
      }
      assertNotLocalSecretFilePath(relativePath);
      const folder = path.dirname(relativePath);
      if (folder !== '.') {
        await container.fs.mkdir(folder, { recursive: true });
      }
      const content = entry.encoding === 'utf8' ? entry.content : decodeBase64(entry.content);
      await container.fs.writeFile(relativePath, content);
      ensureParentFolders(this.files, getAbsolutePath(relativePath));
      this.files.setKey(getAbsolutePath(relativePath), {
        type: 'file',
        content: entry.encoding === 'utf8' ? entry.content : '',
        isBinary: entry.encoding === 'base64',
      });
    }
  }

  async replaceWorkspaceSnapshot(
    entries: BuilderWorkspaceSyncEntry[],
    preservedPaths = new Set<string>(),
  ): Promise<void> {
    const serverPaths = new Set(entries.filter((entry) => entry.kind === 'write').map((entry) => entry.path));
    const deletions: BuilderWorkspaceSyncEntry[] = [];
    for (const [filePath, entry] of Object.entries(this.files.get())) {
      if (entry?.type === 'file' && !serverPaths.has(filePath) && !preservedPaths.has(filePath)) {
        deletions.push({ kind: 'delete', path: filePath, revision: 0 });
      }
    }
    await this.applyWorkspaceSyncEntries([...deletions, ...entries]);
  }

  async flushFileEvents() {
    await this.#watcherRefresh;
    await this.#watchEvents.flush();
  }

  async #refreshFileWatchers(webcontainer: WebContainer) {
    this.#watchDirectory(webcontainer, ROOT_DIRECTORY, false);

    const topLevelEntries = await webcontainer.fs.readdir(ROOT_DIRECTORY, { withFileTypes: true });
    const watchedDirectories = new Set([ROOT_DIRECTORY]);
    for (const entry of topLevelEntries) {
      if (!entry.isDirectory() || isExcludedProjectPath(entry.name) || getLocalSecretRootPath(entry.name) !== null) {
        continue;
      }
      watchedDirectories.add(entry.name);
      this.#watchDirectory(webcontainer, entry.name, true);
    }

    for (const [directory, watcher] of this.#fileWatchers) {
      if (!watchedDirectories.has(directory)) {
        watcher.close();
        this.#fileWatchers.delete(directory);
      }
    }
  }

  #watchDirectory(webcontainer: WebContainer, directory: string, recursive: boolean) {
    if (this.#fileWatchers.has(directory)) {
      return;
    }
    const watcher = webcontainer.fs.watch(directory, { recursive }, (eventType, watcherPath) => {
      const relativePath = normalizeWatchedPath(webcontainer, directory, watcherPath);
      if (!relativePath || isExcludedProjectPath(relativePath)) {
        return;
      }
      this.#watchEvents(eventType, relativePath);
      if (directory === ROOT_DIRECTORY) {
        this.#queueWatcherRefresh(webcontainer);
      }
    });
    this.#fileWatchers.set(directory, watcher);
  }

  #queueWatcherRefresh(webcontainer: WebContainer) {
    this.#watcherRefresh = this.#watcherRefresh
      .then(() => this.#refreshFileWatchers(webcontainer))
      .catch((error) => logger.error('Failed to refresh file watching', error));
  }

  #closeFileWatchers() {
    for (const watcher of this.#fileWatchers.values()) {
      watcher.close();
    }
    this.#fileWatchers.clear();
  }

  async #processEventBuffer(events: WatcherEvent[]) {
    const webcontainer = await this.#webcontainer;
    const filesBeforeReconciliation = { ...this.files.get() };
    const localSecretPaths = new Set<string>();
    const changedPaths = new Set<string>();
    let requiresFullReconciliation = false;

    for (const [, watcherPath] of events) {
      const relativePath = normalizeWatcherPath(webcontainer, watcherPath);
      if (!relativePath) {
        requiresFullReconciliation = true;
        continue;
      }
      if (isExcludedProjectPath(relativePath)) {
        continue;
      }
      incrementFileUpdateCounter(relativePath);
      const localSecretPath = getLocalSecretRootPath(relativePath);
      if (localSecretPath) {
        if (relativePath === '.npmrc') {
          try {
            const content = await webcontainer.fs.readFile(relativePath, 'utf8');
            if (isManagedWebContainerNpmrc(relativePath, content)) {
              this.#removeTrackedPath(localSecretPath);
              continue;
            }
          } catch {
            // Missing or unreadable secret paths are handled by the idempotent purge below.
          }
        }
        localSecretPaths.add(localSecretPath);
        this.#removeTrackedPath(localSecretPath);
      } else {
        changedPaths.add(relativePath);
      }
    }

    try {
      for (const localSecretPath of Array.from(localSecretPaths).sort()) {
        await webcontainer.fs.rm(localSecretPath, { recursive: true, force: true });
        logger.warn('Removed local secret file from generated project', { path: localSecretPath });
      }
    } catch (error) {
      // Never reconcile ordinary content after a failed secret purge.
      logger.error('Failed to remove a watched local secret file\n\n', error);
      return;
    }

    let reconciledScopes: string[] | null = requiresFullReconciliation ? null : Array.from(changedPaths);
    try {
      if (requiresFullReconciliation) {
        await reconcileFileMap(webcontainer, this.files);
      } else {
        await reconcileWatchedPaths(webcontainer, this.files, reconciledScopes ?? []);
      }
      this.#pruneTrackedPaths();
    } catch (error) {
      if (requiresFullReconciliation) {
        logger.error('Failed to reconcile watched project files\n\n', error);
        return;
      }

      logger.warn('Targeted file reconciliation failed; retrying with a full project scan', error);
      try {
        await reconcileFileMap(webcontainer, this.files);
        this.#pruneTrackedPaths();
        reconciledScopes = null;
      } catch (fallbackError) {
        logger.error('Failed to reconcile watched project files\n\n', fallbackError);
        return;
      }
    }
    try {
      await this.#notifyWorkspaceChanges(webcontainer, filesBeforeReconciliation, reconciledScopes);
    } catch (error) {
      logger.warn('Failed to publish watched project changes to the durable workspace', error);
    }
  }

  async #notifyWorkspaceChanges(
    webcontainer: WebContainer,
    before: FileMap,
    relativeScopes: string[] | null,
  ): Promise<void> {
    if (!this.#workspaceChangeListener) {
      return;
    }
    const after = this.files.get();
    const absoluteScopes = relativeScopes?.map(getAbsolutePath) ?? null;
    const relevant = (filePath: string) =>
      !absoluteScopes || absoluteScopes.some((scope) => filePath === scope || filePath.startsWith(`${scope}/`));
    const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
      .filter(relevant)
      .sort((left, right) => left.localeCompare(right));
    const changes: BuilderWorkspaceClientChange[] = [];
    for (const filePath of paths) {
      const previous = before[filePath as AbsolutePath];
      const current = after[filePath as AbsolutePath];
      if (previous?.type !== 'file' && current?.type !== 'file') {
        continue;
      }
      if (current?.type !== 'file') {
        changes.push({ kind: 'delete', path: filePath });
        continue;
      }
      if (
        previous?.type === 'file' &&
        previous.isBinary === current.isBinary &&
        previous.content === current.content &&
        !current.isBinary
      ) {
        continue;
      }
      if (current.isBinary) {
        const relativePath = path.relative(webcontainer.workdir, filePath);
        changes.push({
          kind: 'write',
          path: filePath,
          content: encodeBase64(await webcontainer.fs.readFile(relativePath)),
          encoding: 'base64',
        });
      } else {
        changes.push({ kind: 'write', path: filePath, content: current.content, encoding: 'utf8' });
      }
    }
    if (changes.length > 0) {
      await this.#workspaceChangeListener(changes);
    }
  }

  async #notifyWorkspaceWrite(filePath: AbsolutePath, content: string): Promise<void> {
    await this.#workspaceChangeListener?.([
      {
        kind: 'write',
        path: filePath,
        content,
        encoding: 'utf8',
      },
    ]);
  }

  #removeTrackedPath(filePath: string) {
    const absolutePath = getAbsolutePath(filePath.replace(/\/+$/g, ''));
    this.files.setKey(absolutePath, undefined);
    const childPrefix = `${absolutePath}/`;
    for (const candidatePath of Object.keys(this.files.get())) {
      if (candidatePath.startsWith(childPrefix)) {
        this.files.setKey(getAbsolutePath(candidatePath), undefined);
      }
    }
    for (const candidatePath of this.#modifiedFiles.keys()) {
      if (candidatePath === absolutePath || candidatePath.startsWith(childPrefix)) {
        this.#modifiedFiles.delete(candidatePath);
      }
    }
    for (const candidatePath of this.userWrites.keys()) {
      if (candidatePath === absolutePath || candidatePath.startsWith(childPrefix)) {
        this.userWrites.delete(candidatePath);
      }
    }
  }

  #pruneTrackedPaths() {
    const currentFiles = this.files.get();
    for (const filePath of this.#modifiedFiles.keys()) {
      if (currentFiles[filePath]?.type !== 'file') {
        this.#modifiedFiles.delete(filePath);
      }
    }
    for (const filePath of this.userWrites.keys()) {
      if (currentFiles[filePath]?.type !== 'file') {
        this.userWrites.delete(filePath);
      }
    }
  }
}

const FILE_EVENTS_DEBOUNCE_MS = 100;
const ROOT_DIRECTORY = '.';
type WatcherEvent = [event: 'rename' | 'change', path: string | Uint8Array];

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeWatchedPath(
  webcontainer: WebContainer,
  watchedDirectory: string,
  watcherPath: string | Uint8Array,
): string | null {
  const relativePath = normalizeWatcherPath(webcontainer, watcherPath);
  if (
    !relativePath ||
    watchedDirectory === ROOT_DIRECTORY ||
    relativePath === watchedDirectory ||
    relativePath.startsWith(`${watchedDirectory}/`)
  ) {
    return relativePath;
  }
  return path.join(watchedDirectory, relativePath);
}
