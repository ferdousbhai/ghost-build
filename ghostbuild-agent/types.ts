import type { AbsolutePath } from './utils/workDir.js';
import type { Tool } from './tool.js';
import type { AlwaysAvailableModelToolName, CloudflareMcpModelToolName, ModelToolName } from './model-tool-inputs.js';

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

export type GhostbuildToolSet = Record<AlwaysAvailableModelToolName, Tool> &
  Partial<Record<CloudflareMcpModelToolName, Tool>>;

/** A canonical model tool name, retained here for consumers that build dynamic tool maps. */
export type GhostbuildModelToolName = ModelToolName;

export type Dirent = File | Folder;

export type FileMap = Record<AbsolutePath, Dirent | undefined>;
