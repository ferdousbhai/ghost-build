import type { GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import type { DeploymentProjectProfile } from '~/lib/.server/cloudflare/deployment-project-profile';
import type { BuilderPreviewSuccess } from './builder-preview-types';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceSeedStartResult,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from './builder-workspace-types';

export type BuilderWorkspaceFileMetadata = {
  path: string;
  encoding: 'utf8' | 'base64';
  size: number;
  sha256: string;
  revision: number;
};

export type BuilderWorkspaceCheckpoint = {
  workspaceRevision: number;
  revision: string;
};

/**
 * Project workspace operations available to the Ghostbuild control plane.
 *
 * Deliberately excludes DirectoryBackup and raw archive access. Those values
 * never cross out of the user's Cloudflare account.
 */
export interface BuilderWorkspaceApi {
  refresh(): Promise<BuilderWorkspaceState>;
  getState(): BuilderWorkspaceState;
  beginSeed(seedId: unknown): Promise<BuilderWorkspaceSeedStartResult>;
  appendSeed(seedId: unknown, entries: unknown): Promise<BuilderWorkspaceState>;
  commitSeed(seedId: unknown, expected: unknown): Promise<BuilderWorkspaceState>;
  abortSeed(seedId: unknown): Promise<BuilderWorkspaceState>;
  applyClientChanges(value: unknown): Promise<BuilderWorkspaceApplyResult>;
  getSyncPage(value: unknown): Promise<BuilderWorkspaceSyncPage>;
  readText(path: unknown): Promise<{
    path: string;
    content: string;
    encoding: 'utf8';
    size: number;
    sha256: string;
    revision: number;
  }>;
  readFile(path: unknown): Promise<{
    path: string;
    bytes: Uint8Array;
    encoding: 'utf8' | 'base64';
    size: number;
    sha256: string;
    revision: number;
  }>;
  listFiles(): BuilderWorkspaceFileMetadata[];
  checkpoint(): Promise<BuilderWorkspaceCheckpoint>;
  executeToolOnce<T>(toolCallId: unknown, toolName: string, args: unknown, execute: () => Promise<T>): Promise<T>;
  commitTextTool<T>(args: {
    toolCallId: unknown;
    toolName: 'edit' | 'writeFile';
    toolArgs: unknown;
    path: unknown;
    content: string;
    expectedFileSha256?: string | null;
    result: (context: { path: string; bytes: number; changed: boolean; workspaceRevision: number }) => T;
  }): Promise<T>;
  installDependencies(args: {
    toolCallId: string;
    input: unknown;
    mode: 'add' | 'sync-lockfile';
    packages: string[];
  }): Promise<GhostbuildToolResult>;
  validate(args: { toolCallId: string; input: unknown }): Promise<GhostbuildToolResult>;
  hasSuccessfulValidation(revision: string): Promise<boolean>;
  prepareDeployment(revision: string): Promise<{
    workspaceRevision: number;
    revision: string;
    project: DeploymentProjectProfile;
  }>;
  createPreview(previewId: string): Promise<BuilderPreviewSuccess>;
  stopPreview(previewId: string): Promise<void>;
  deploy(args: Record<string, unknown> & { revision: string; deploymentId: string }): Promise<{
    workerName: string;
    workerVersionId: string;
  }>;
  deleteProject(): Promise<void>;
}
