import type { AbsolutePath } from './utils/workDir.js';
import type { Tool } from 'ai';

export interface EditorDocument {
  value: string;
  isBinary: boolean;
  filePath: AbsolutePath;
  scroll?: ScrollPosition;
}

export interface ScrollPosition {
  top: number;
  left: number;
}

export interface File {
  type: 'file';
  content: string;
  isBinary: boolean;
}

interface Folder {
  type: 'folder';
}

export type GhostbuildToolSet = {
  deploy: Tool;
  edit: Tool;
  listFiles: Tool;
  lookupDocs: Tool;
  npmInstall: Tool;
  searchText: Tool;
  validateProject: Tool;
  view: Tool;
  writeFile: Tool;
};

export type GhostbuildToolName = keyof GhostbuildToolSet;

export const READ_ONLY_TOOL_NAMES = [
  'view',
  'listFiles',
  'searchText',
  'lookupDocs',
] as const satisfies readonly GhostbuildToolName[];

export function isReadOnlyToolName(toolName: string): boolean {
  return (READ_ONLY_TOOL_NAMES as readonly string[]).includes(toolName);
}

export type Dirent = File | Folder;

export type FileMap = Record<AbsolutePath, Dirent | undefined>;
