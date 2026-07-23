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

const logger = createScopedLogger('FilesStore');

export class FilesStore {
  #webcontainer: Promise<WebContainer>;
  #watchEvents = bufferWatchEvents<WatcherEvent>(FILE_EVENTS_DEBOUNCE_MS, this.#processEventBuffer.bind(this));
  #fileWatcher: IFSWatcher | undefined;

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

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;

    if (import.meta.hot) {
      import.meta.hot.data.files = this.files;
      import.meta.hot.data.modifiedFiles = this.#modifiedFiles;
      import.meta.hot.data.userWrites = this.userWrites;
      import.meta.hot.dispose(() => this.#fileWatcher?.close());
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

  setGeneratedFile(filePath: AbsolutePath, content: string) {
    ensureParentFolders(this.files, filePath);

    this.files.setKey(filePath, { type: 'file', content, isBinary: false });
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
    } catch (error) {
      logger.error('Failed to update file content\n\n', error);

      throw error;
    }
  }

  async #init() {
    const webcontainer = await this.#webcontainer;
    this.#fileWatcher = webcontainer.fs.watch(ROOT_DIRECTORY, { recursive: true }, (eventType, watcherPath) => {
      const relativePath = normalizeWatcherPath(webcontainer, watcherPath);
      if (relativePath && isExcludedProjectPath(relativePath)) {
        return;
      }
      this.#watchEvents(eventType, watcherPath);
    });
  }

  async prewarmWorkdir(container: WebContainer) {
    await reconcileFileMap(container, this.files);
  }

  flushFileEvents() {
    return this.#watchEvents.flush();
  }

  async #processEventBuffer(events: WatcherEvent[]) {
    const webcontainer = await this.#webcontainer;
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

    try {
      if (requiresFullReconciliation) {
        await reconcileFileMap(webcontainer, this.files);
      } else {
        await reconcileWatchedPaths(webcontainer, this.files, Array.from(changedPaths));
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
      } catch (fallbackError) {
        logger.error('Failed to reconcile watched project files\n\n', fallbackError);
      }
    }
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
