import type { WebContainer } from '@webcontainer/api';
import type { MapStore } from 'nanostores';
import { WORK_DIR } from 'ghostbuild-agent/constants.js';
import type { FileMap } from 'ghostbuild-agent/types';
import { path } from 'ghostbuild-agent/utils/path';
import { getAbsolutePath, type AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { isLocalSecretFilePath } from '~/utils/secretFiles';
import { decodeFileContent, isBinaryFile } from './file-content';

const ROOT_DIRECTORY = '.';
const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.ghostbuild',
  '.output',
  '.turbo',
  '.vite',
  '.wrangler',
  'coverage',
  'dist',
  'dist-ssr',
  'node_modules',
]);
const EXCLUDED_FILE_NAMES = new Set(['.gitignore']);

type ProjectEntry = { type: 'folder' } | { type: 'file'; relativePath: string };
type ProjectDirent = { name: string; isFile(): boolean; isDirectory(): boolean };
type DirectoryEntriesCache = Map<string, Promise<ProjectDirent[]>>;

/**
 * Rebuild the file map from the documented WebContainer filesystem API.
 *
 * Discovery deliberately completes before any project file is read. This lets
 * us purge secret-bearing paths first and ensures a failed purge cannot expose
 * unrelated project content through the in-memory map.
 */
export async function reconcileFileMap(container: WebContainer, files: MapStore<FileMap>): Promise<void> {
  // A mounted repository from an older snapshot must never be traversed.
  await removePersistedPath(container, files, '.git');

  const entries = new Map<AbsolutePath, ProjectEntry>();
  const localSecretPaths = new Set<string>();
  await discoverProjectEntries(container, ROOT_DIRECTORY, entries, localSecretPaths, new Map());

  for (const relativePath of Array.from(localSecretPaths).sort()) {
    await removePersistedPath(container, files, relativePath);
  }

  const nextFiles = await readProjectEntries(container, entries);

  reconcileProjectEntries(files, nextFiles);
}

/**
 * Reconcile only paths named by the public fs watcher. Directory events scan
 * their subtree; duplicate and descendant events are collapsed first.
 */
export async function reconcileWatchedPaths(
  container: WebContainer,
  files: MapStore<FileMap>,
  relativePaths: string[],
): Promise<void> {
  const scopes = collapseWatcherPaths(relativePaths);
  if (scopes.length === 0) {
    return;
  }

  const entries = new Map<AbsolutePath, ProjectEntry>();
  const localSecretPaths = new Set<string>();
  const directoryEntries = new Map<string, Promise<ProjectDirent[]>>();
  for (const relativePath of scopes) {
    const localSecretPath = getLocalSecretRootPath(relativePath);
    if (localSecretPath) {
      localSecretPaths.add(localSecretPath);
      continue;
    }
    if (isExcludedProjectPath(relativePath)) {
      continue;
    }

    const dirent = await findProjectEntry(container, relativePath, directoryEntries);
    if (!dirent) {
      continue;
    }
    if (dirent.isDirectory()) {
      entries.set(getAbsolutePath(relativePath), { type: 'folder' });
      await discoverProjectEntries(container, relativePath, entries, localSecretPaths, directoryEntries);
      continue;
    }
    if (dirent.isFile()) {
      entries.set(getAbsolutePath(relativePath), { type: 'file', relativePath });
      continue;
    }
    throw new Error(`Unsupported project filesystem entry: ${relativePath}`);
  }

  for (const relativePath of Array.from(localSecretPaths).sort()) {
    await removePersistedPath(container, files, relativePath);
  }

  const nextFiles = await readProjectEntries(container, entries);
  reconcileProjectScopes(files, nextFiles, scopes);
}

async function discoverProjectEntries(
  container: WebContainer,
  relativeDirectory: string,
  entries: Map<AbsolutePath, ProjectEntry>,
  localSecretPaths: Set<string>,
  directoryEntries: DirectoryEntriesCache,
): Promise<void> {
  const dirents = await readProjectDirectory(container, relativeDirectory, directoryEntries);

  for (const dirent of dirents) {
    assertSafeDirentName(dirent.name);
    const relativePath = relativeDirectory === ROOT_DIRECTORY ? dirent.name : path.join(relativeDirectory, dirent.name);

    const localSecretPath = getLocalSecretRootPath(relativePath);
    if (localSecretPath) {
      localSecretPaths.add(localSecretPath);
      continue;
    }

    if (dirent.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(dirent.name)) {
        continue;
      }
      entries.set(getAbsolutePath(relativePath), { type: 'folder' });
      await discoverProjectEntries(container, relativePath, entries, localSecretPaths, directoryEntries);
      continue;
    }

    if (dirent.isFile()) {
      if (!EXCLUDED_FILE_NAMES.has(dirent.name)) {
        entries.set(getAbsolutePath(relativePath), { type: 'file', relativePath });
      }
      continue;
    }

    throw new Error(`Unsupported project filesystem entry: ${relativePath}`);
  }
}

function assertSafeDirentName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`Unsafe project filesystem entry: ${name || '<empty>'}`);
  }
}

async function findProjectEntry(
  container: WebContainer,
  relativePath: string,
  directoryEntries: DirectoryEntriesCache,
) {
  const parentDirectory = path.dirname(relativePath);
  const entryName = path.basename(relativePath);
  const dirents = await readProjectDirectory(container, parentDirectory, directoryEntries);
  for (const dirent of dirents) {
    assertSafeDirentName(dirent.name);
    if (dirent.name === entryName) {
      return dirent;
    }
  }
  return undefined;
}

function readProjectDirectory(
  container: WebContainer,
  relativeDirectory: string,
  directoryEntries: DirectoryEntriesCache,
): Promise<ProjectDirent[]> {
  let entries = directoryEntries.get(relativeDirectory);
  if (!entries) {
    entries = container.fs
      .readdir(relativeDirectory, { withFileTypes: true })
      .then((dirents) => dirents.sort((left, right) => left.name.localeCompare(right.name)));
    directoryEntries.set(relativeDirectory, entries);
  }
  return entries;
}

async function readProjectEntries(container: WebContainer, entries: Map<AbsolutePath, ProjectEntry>): Promise<FileMap> {
  const nextFiles = {} as FileMap;
  const projectEntries = Array.from(entries.entries()).sort(([left], [right]) => left.localeCompare(right));
  for (const [absolutePath, entry] of projectEntries) {
    if (entry.type === 'folder') {
      nextFiles[absolutePath] = { type: 'folder' };
      continue;
    }

    const buffer = await container.fs.readFile(entry.relativePath);
    const isBinary = isBinaryFile(buffer);
    nextFiles[absolutePath] = {
      type: 'file',
      content: isBinary ? '' : decodeFileContent(buffer),
      isBinary,
    };
  }
  return nextFiles;
}

function collapseWatcherPaths(relativePaths: string[]): string[] {
  const sortedPaths = Array.from(new Set(relativePaths)).sort((left, right) => {
    const depthDifference = pathDepth(left) - pathDepth(right);
    return depthDifference === 0 ? left.localeCompare(right) : depthDifference;
  });
  const collapsedPaths: string[] = [];
  for (const relativePath of sortedPaths) {
    if (!collapsedPaths.some((parentPath) => relativePath.startsWith(`${parentPath}/`))) {
      collapsedPaths.push(relativePath);
    }
  }
  return collapsedPaths;
}

function pathDepth(relativePath: string): number {
  return relativePath.split('/').length;
}

export function isExcludedProjectPath(relativePath: string): boolean {
  const segments = relativePath.split('/');
  return (
    segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment)) || EXCLUDED_FILE_NAMES.has(segments.at(-1) ?? '')
  );
}

function reconcileProjectEntries(files: MapStore<FileMap>, nextFiles: FileMap): void {
  for (const filePath of Object.keys(files.get())) {
    const absoluteFilePath = getAbsolutePath(filePath);
    if (isWorkdirChild(filePath) && nextFiles[absoluteFilePath] === undefined) {
      files.setKey(absoluteFilePath, undefined);
    }
  }

  for (const [filePath, entry] of Object.entries(nextFiles)) {
    files.setKey(getAbsolutePath(filePath), entry);
  }
}

function reconcileProjectScopes(files: MapStore<FileMap>, nextFiles: FileMap, relativeScopes: string[]): void {
  const absoluteScopes = relativeScopes.map(getAbsolutePath);
  for (const filePath of Object.keys(files.get())) {
    const absoluteFilePath = getAbsolutePath(filePath);
    const isInScope = absoluteScopes.some(
      (absoluteScope) => absoluteFilePath === absoluteScope || absoluteFilePath.startsWith(`${absoluteScope}/`),
    );
    if (isInScope && nextFiles[absoluteFilePath] === undefined) {
      files.setKey(absoluteFilePath, undefined);
    }
  }

  for (const [filePath, entry] of Object.entries(nextFiles)) {
    const absoluteFilePath = getAbsolutePath(filePath);
    ensureParentFolders(files, absoluteFilePath);
    files.setKey(absoluteFilePath, entry);
  }
}

function isWorkdirChild(filePath: string): boolean {
  return filePath.startsWith(`${WORK_DIR}/`);
}

async function removePersistedPath(
  container: WebContainer,
  files: MapStore<FileMap>,
  relativePath: string,
): Promise<void> {
  const absolutePath = getAbsolutePath(relativePath);
  files.setKey(absolutePath, undefined);
  const childPrefix = `${absolutePath}/`;
  for (const filePath of Object.keys(files.get())) {
    if (filePath.startsWith(childPrefix)) {
      files.setKey(getAbsolutePath(filePath), undefined);
    }
  }
  await container.fs.rm(relativePath, { recursive: true, force: true });
}

export function normalizeWatcherPath(container: WebContainer, watcherPath: string | Uint8Array): string | null {
  const decodedPath = typeof watcherPath === 'string' ? watcherPath : new TextDecoder().decode(watcherPath);
  const withoutTrailingSlash = decodedPath.replace(/\/+$/g, '');
  if (!withoutTrailingSlash) {
    return null;
  }

  const relativePath = path.isAbsolute(withoutTrailingSlash)
    ? path.relative(container.workdir, withoutTrailingSlash)
    : path.normalize(withoutTrailingSlash).replace(/^\.\//, '');

  return relativePath &&
    relativePath !== '.' &&
    relativePath !== '..' &&
    !relativePath.startsWith('../') &&
    !path.isAbsolute(relativePath)
    ? relativePath
    : null;
}

export function getLocalSecretRootPath(relativePath: string): string | null {
  const segments = relativePath.split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    if (isLocalSecretFilePath(segments[index])) {
      return segments.slice(0, index + 1).join('/');
    }
  }
  return null;
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
