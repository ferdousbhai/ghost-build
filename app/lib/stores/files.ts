import type { WebContainer } from '@webcontainer/api';
import { map, type MapStore } from 'nanostores';
import { path } from 'ghostbuild-agent/utils/path';
import { bufferWatchEvents } from '~/utils/buffer';
import { WORK_DIR } from 'ghostbuild-agent/constants.js';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { unreachable } from 'ghostbuild-agent/utils/unreachable';
import { getAbsolutePath, type AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import type { File, FileMap } from 'ghostbuild-agent/types';
import { assertNotLocalSecretFilePath } from '~/utils/secretFiles';
import { assertValidGeneratedPackageJson } from '~/utils/generatedPackageManifest';
import { applyFileWatchEvents, ensureParentFolders, prewarmFileMap } from './file-map-operations';

const logger = createScopedLogger('FilesStore');

export class FilesStore {
  #webcontainer: Promise<WebContainer>;
  #watchEvents = bufferWatchEvents(FILE_EVENTS_DEBOUNCE_MS, this.#processEventBuffer.bind(this));

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
    webcontainer.internal.watchPaths(
      { include: [`${WORK_DIR}/**`], exclude: ['**/node_modules', '.git'], includeContent: true },
      this.#watchEvents,
    );
  }

  async prewarmWorkdir(container: WebContainer) {
    await prewarmFileMap(container, this.files);
  }

  flushFileEvents() {
    return this.#watchEvents.flush();
  }

  #processEventBuffer(events: Parameters<typeof applyFileWatchEvents>[0]) {
    applyFileWatchEvents(events, this.files, (filePath) => {
      void this.#removeLocalSecretFile(filePath);
    });
  }

  async #removeLocalSecretFile(filePath: string) {
    const absolutePath = getAbsolutePath(filePath);
    this.files.setKey(absolutePath, undefined);
    this.#modifiedFiles.delete(absolutePath);
    this.userWrites.delete(absolutePath);

    try {
      const webcontainer = await this.#webcontainer;
      const relativePath = path.relative(webcontainer.workdir, filePath);
      if (!relativePath) {
        return;
      }
      await webcontainer.fs.rm(relativePath, { recursive: true, force: true });
      logger.warn('Removed local secret file from generated project', { path: relativePath });
    } catch (error) {
      logger.error('Failed to remove local secret file\n\n', error);
    }
  }
}

const FILE_EVENTS_DEBOUNCE_MS = 100;
