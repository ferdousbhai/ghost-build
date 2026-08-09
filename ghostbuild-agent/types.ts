import type { AbsolutePath } from './utils/workDir.js';
import type { Tool } from './pi-tool-compat.js';
import type { ComputerToolName } from './cloudflare-computer.js';

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

export type GhostbuildToolSet = Record<ComputerToolName, Tool> & {
  deploy: Tool;
  lookupDocs: Tool;
  npmInstall: Tool;
  validateProject: Tool;
};

export type GhostbuildToolName = keyof GhostbuildToolSet;

export const READ_ONLY_TOOL_NAMES = ['read', 'ls', 'lookupDocs'] as const satisfies readonly GhostbuildToolName[];

export function isReadOnlyToolName(toolName: string): boolean {
  return (READ_ONLY_TOOL_NAMES as readonly string[]).includes(toolName);
}

export type Dirent = File | Folder;

export type FileMap = Record<AbsolutePath, Dirent | undefined>;
