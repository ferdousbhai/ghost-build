import type { PathWatcherEvent, WebContainer } from '@webcontainer/api';
import type { MapStore } from 'nanostores';
import { WORK_DIR } from 'ghostbuild-agent/constants.js';
import type { FileMap } from 'ghostbuild-agent/types';
import { path } from 'ghostbuild-agent/utils/path';
import { getAbsolutePath, type AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { incrementFileUpdateCounter } from './fileUpdateCounter';
import { isLocalSecretFilePath } from '~/utils/secretFiles';
import { decodeFileContent, isBinaryFile } from './file-content';

type WebContainerInternalSearch = {
  fileSearch(patterns: string[], root: string, options: { excludes: string[] }): Promise<string[]>;
};

export async function prewarmFileMap(container: WebContainer, files: MapStore<FileMap>): Promise<void> {
  const internal = container.internal as unknown as WebContainerInternalSearch;
  const absoluteFilePaths = await internal.fileSearch([], WORK_DIR, { excludes: ['.gitignore', 'node_modules'] });
  const directories = new Set<string>();
  for (const absolutePath of absoluteFilePaths) {
    if (isLocalSecretFilePath(absolutePath)) {
      continue;
    }
    const relativePath = path.relative(container.workdir, absolutePath);
    if (relativePath) {
      directories.add(path.dirname(absolutePath));
    }
  }
  for (const directory of Array.from(directories).sort()) {
    files.setKey(getAbsolutePath(directory.replace(/\/+$/g, '')), { type: 'folder' });
  }
  await Promise.all(
    absoluteFilePaths.map(async (absolutePath) => {
      if (isLocalSecretFilePath(absolutePath) || !path.relative(container.workdir, absolutePath)) {
        return;
      }
      const buffer = await container.fs.readFile(path.relative(container.workdir, absolutePath));
      const isBinary = isBinaryFile(buffer);
      files.setKey(getAbsolutePath(absolutePath), {
        type: 'file',
        content: isBinary ? '' : decodeFileContent(buffer),
        isBinary,
      });
    }),
  );
}

export function applyFileWatchEvents(
  events: Array<[events: PathWatcherEvent[]]>,
  files: MapStore<FileMap>,
  onLocalSecret: (filePath: string) => void,
): void {
  for (const { type, path: eventPath, buffer } of events.flat(2)) {
    const sanitizedPath = eventPath.replace(/\/+$/g, '');
    incrementFileUpdateCounter(sanitizedPath);
    if (isLocalSecretFilePath(sanitizedPath)) {
      onLocalSecret(sanitizedPath);
      continue;
    }
    switch (type) {
      case 'add_dir':
        files.setKey(getAbsolutePath(sanitizedPath), { type: 'folder' });
        break;
      case 'remove_dir': {
        files.setKey(getAbsolutePath(sanitizedPath), undefined);
        const childPrefix = `${sanitizedPath}/`;
        for (const filePath of Object.keys(files.get())) {
          if (filePath.startsWith(childPrefix)) {
            files.setKey(getAbsolutePath(filePath), undefined);
          }
        }
        break;
      }
      case 'add_file':
      case 'change': {
        const isBinary = isBinaryFile(buffer);
        files.setKey(getAbsolutePath(sanitizedPath), {
          type: 'file',
          content: isBinary ? '' : decodeFileContent(buffer),
          isBinary,
        });
        break;
      }
      case 'remove_file':
        files.setKey(getAbsolutePath(sanitizedPath), undefined);
        break;
      case 'update_directory':
        break;
    }
  }
}

export function ensureParentFolders(files: MapStore<FileMap>, filePath: AbsolutePath): void {
  const folders: AbsolutePath[] = [];
  let current = path.dirname(filePath);
  while (current !== WORK_DIR && current.startsWith(`${WORK_DIR}/`)) {
    folders.unshift(getAbsolutePath(current));
    current = path.dirname(current);
  }
  for (const folder of folders) {
    if (files.get()[folder]?.type !== 'folder') {
      files.setKey(folder, { type: 'folder' });
    }
  }
}
