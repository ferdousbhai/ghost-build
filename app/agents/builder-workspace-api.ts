import type { GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import type { CreateAIToolsOptions } from '@cloudflare/computer/tools';
import type { DeploymentProjectProfile } from '~/lib/.server/cloudflare/deployment-project-profile';
import type { PreparedDeploymentArtifact } from '~/lib/.server/cloudflare/deployment-artifact';
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
  mode: number;
  sha256: string;
  revision: number;
};

export type BuilderWorkspaceCheckpoint = {
  workspaceRevision: number;
  revision: string;
};

export interface ProjectWorkspaceRpc extends Rpc.DurableObjectBranded {
  initializeProjectIdentity(value: { projectId: string; userId: string }): void | Promise<void>;
  beginToolOperation(
    value: unknown,
  ): Promise<
    | { status: 'execute' }
    | { status: 'completed'; result: unknown }
    | { status: 'failed' | 'indeterminate'; error: string }
  >;
  completeToolOperation(value: unknown): unknown | Promise<unknown>;
  failToolOperation(value: unknown): void | Promise<void>;
  getWorkspaceState(): Promise<BuilderWorkspaceState>;
  getWorkspaceSnapshot(): Promise<{ state: BuilderWorkspaceState; files: BuilderWorkspaceFileMetadata[] }>;
  beginSeed(seedId: unknown): Promise<BuilderWorkspaceSeedStartResult>;
  appendSeed(seedId: unknown, entries: unknown): Promise<BuilderWorkspaceState>;
  commitSeed(seedId: unknown, expected: unknown): Promise<BuilderWorkspaceState>;
  abortSeed(seedId: unknown): Promise<BuilderWorkspaceState>;
  applyChanges(value: unknown): Promise<BuilderWorkspaceApplyResult>;
  getSyncPage(value: unknown): Promise<BuilderWorkspaceSyncPage>;
  readText(path: unknown): ReturnType<BuilderWorkspaceApi['readText']>;
  readWorkspaceFile(path: unknown): ReturnType<BuilderWorkspaceApi['readFile']>;
  streamWorkspaceFile(path: unknown): Promise<ReadableStream<Uint8Array>>;
  listWorkspaceFiles(): Promise<BuilderWorkspaceFileMetadata[]>;
  readDirectory(path: unknown): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>>;
  makeDirectory(path: unknown): Promise<void>;
  execute(value: unknown): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  checkpoint(): Promise<BuilderWorkspaceCheckpoint>;
  installDependenciesTool(value: unknown): Promise<GhostbuildToolResult>;
  validateTool(value: unknown): Promise<GhostbuildToolResult>;
  validationStatus(revision: unknown): { valid: boolean } | Promise<{ valid: boolean }>;
  deploymentPlan(revision: unknown): ReturnType<BuilderWorkspaceApi['prepareDeployment']>;
  beginDeploymentSession(value: {
    operationId: string;
    expectedWorkspaceRevision: number;
    expectedSnapshotRevision: string;
  }): Promise<{ sessionId: string }>;
  assertDeploymentSession(value: { sessionId: string }): Promise<BuilderWorkspaceCheckpoint>;
  prepareDeploymentArtifact(
    value: Record<string, unknown> & { sessionId: string },
  ): Promise<PreparedDeploymentArtifact>;
  finishDeploymentSession(value: {
    sessionId: string;
    status: 'completed' | 'failed';
  }): Promise<{ status: 'completed' | 'failed' }>;
  createPreview(value: unknown): Promise<BuilderPreviewSuccess>;
  stopPreview(previewId: unknown): Promise<void>;
  deleteProject(): Promise<void>;
}

/**
 * Project workspace operations available to the Ghostbuild control plane.
 *
 * The Cloudflare Computer VFS remains the sole source of truth. This facade
 * exposes product operations without exposing the underlying DO storage.
 */
export interface BuilderWorkspaceApi {
  readonly computer: CreateAIToolsOptions['workspace'];
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
    mode: number;
    sha256: string;
    revision: number;
  }>;
  listFiles(): BuilderWorkspaceFileMetadata[];
  checkpoint(): Promise<BuilderWorkspaceCheckpoint>;
  executeToolOnce<T>(toolCallId: unknown, toolName: string, args: unknown, execute: () => Promise<T>): Promise<T>;
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
  createPreview(args: {
    previewId: string;
    expectedWorkspaceRevision: number;
    expectedSnapshotRevision: string;
  }): Promise<BuilderPreviewSuccess>;
  stopPreview(previewId: string): Promise<void>;
  deleteProject(): Promise<void>;
}
