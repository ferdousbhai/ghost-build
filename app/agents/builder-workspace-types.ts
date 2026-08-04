export const BUILDER_WORKSPACE_SYNC_BATCH_BYTES = 4 * 1024 * 1024;
export const BUILDER_WORKSPACE_SYNC_BATCH_FILES = 100;

export const SERVER_OPERATION_TOOL_NAMES = ['lookupDocs', 'npmInstall', 'validateProject', 'deploy'] as const;
export type ServerOperationToolName = (typeof SERVER_OPERATION_TOOL_NAMES)[number];

export type BuilderWorkspaceEncoding = 'utf8' | 'base64';

export type BuilderWorkspaceFileInput = {
  path: string;
  content: string;
  encoding?: BuilderWorkspaceEncoding;
};

export type BuilderWorkspaceClientChange =
  | {
      kind: 'write';
      path: string;
      content: string;
      encoding?: BuilderWorkspaceEncoding;
      mode?: number;
    }
  | {
      kind: 'delete';
      path: string;
    };

export type BuilderWorkspaceState = {
  initialized: boolean;
  revision: number;
  resetRevision: number;
  fileCount: number;
  totalBytes: number;
  seeding: boolean;
};

export type BuilderWorkspaceSyncEntry =
  | {
      kind: 'write';
      path: string;
      content: string;
      encoding: BuilderWorkspaceEncoding;
      size: number;
      sha256: string;
      revision: number;
    }
  | {
      kind: 'delete';
      path: string;
      revision: number;
    };

export type BuilderWorkspaceSyncPage = {
  state: BuilderWorkspaceState;
  fromRevision: number;
  targetRevision: number;
  mode: 'current' | 'snapshot' | 'delta';
  entries: BuilderWorkspaceSyncEntry[];
  nextCursor?: string;
  restart?: boolean;
};

export type BuilderWorkspaceSeedStartResult =
  | { status: 'initialized'; state: BuilderWorkspaceState }
  | { status: 'seeding'; state: BuilderWorkspaceState }
  | { status: 'started'; seedId: string; state: BuilderWorkspaceState };

export type BuilderWorkspaceApplyResult =
  | {
      ok: true;
      state: BuilderWorkspaceState;
      changedPaths: string[];
    }
  | {
      ok: false;
      conflict: true;
      state: BuilderWorkspaceState;
    };
