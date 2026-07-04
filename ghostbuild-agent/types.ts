import type { AbsolutePath, RelativePath } from './utils/workDir.js';
import type { Tool } from 'ai';
import type { GhostbuildToolInvocation } from './ai-compat.js';

export interface ArtifactData {
  id: string;
  title: string;
  type?: string | undefined;
}

export type ActionType = 'file' | 'toolUse';

export interface FileAction {
  type: 'file';
  filePath: RelativePath;
  isEdit?: boolean;
  content: string;
}

interface ToolUseAction {
  type: 'toolUse';
  toolName: string;
  parsedContent: GhostbuildToolInvocation;
  // Serialized content to use for de-duping
  content: string;
}

export type ArtifactAction = FileAction | ToolUseAction;

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
  npmInstall: Tool;
  lookupDocs: Tool;
  view?: Tool;
  edit?: Tool;
};

export type Dirent = File | Folder;

export type FileMap = Record<AbsolutePath, Dirent | undefined>;
