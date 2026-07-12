import type { WebContainer } from '@webcontainer/api';
import { path as nodePath } from 'ghostbuild-agent/utils/path';
import { unreachable } from 'ghostbuild-agent/utils/unreachable';
import { viewParameters } from 'ghostbuild-agent/tools/view';
import { editToolParameters } from 'ghostbuild-agent/tools/edit';
import { writeFileParameters } from 'ghostbuild-agent/tools/writeFile';
import { renderDirectory } from 'ghostbuild-agent/utils/renderDirectory';
import { renderFile } from 'ghostbuild-agent/utils/renderFile';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { readPath, workDirRelative } from '~/utils/fileUtils';
import { assertNotLocalSecretFilePath } from '~/utils/secretFiles';
import { assertValidGeneratedPackageJson } from '~/utils/generatedPackageManifest';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { ActionRunnerWorkspace, ActionState } from './types';

const logger = createScopedLogger('ActionRunner.FileTools');

export async function runArtifactFileAction(
  action: ActionState,
  container: WebContainer,
  workspace: ActionRunnerWorkspace,
): Promise<void> {
  if (action.type !== 'file') {
    unreachable('Expected file action');
  }
  const relativePath = nodePath.relative(container.workdir, action.filePath);
  await writeGeneratedFile(container, workspace, relativePath, action.filePath, action.content);
  logger.debug(`File written ${relativePath}`);
}

export async function runFileTool(
  invocation: GhostbuildToolInvocation,
  container: WebContainer,
  workspace: ActionRunnerWorkspace,
): Promise<string> {
  switch (invocation.toolName) {
    case 'view': {
      const args = viewParameters.parse(invocation.args);
      const file = await readPath(container, workDirRelative(args.path));
      if (file.type === 'directory') {
        return renderDirectory(file.children);
      }
      if (args.view_range && args.view_range.length !== 2) {
        throw new Error('When provided, view_range must be an array of two numbers');
      }
      return renderFile(file.content, args.view_range as [number, number]);
    }
    case 'edit': {
      const args = editToolParameters.parse(invocation.args);
      const relativePath = workDirRelative(args.path);
      assertNotLocalSecretFilePath(relativePath);
      const file = await readPath(container, relativePath);
      if (file.type !== 'file') {
        throw new Error('Expected a file');
      }
      const firstMatch = file.content.indexOf(args.old);
      if (firstMatch === -1) {
        throw new Error(`Old text not found: ${args.old}`);
      }
      if (file.content.indexOf(args.old, firstMatch + args.old.length) !== -1) {
        throw new Error(`Old text found multiple times: ${args.old}`);
      }
      const content = file.content.replace(args.old, args.new);
      await writeGeneratedFile(container, workspace, relativePath, args.path, content);
      return `Successfully edited ${args.path}`;
    }
    case 'writeFile': {
      const args = writeFileParameters.parse(invocation.args);
      const relativePath = workDirRelative(args.path);
      await writeGeneratedFile(container, workspace, relativePath, args.path, args.content);
      return `Successfully wrote ${args.path}`;
    }
    default:
      throw new Error(`Expected a file tool, received ${invocation.toolName}`);
  }
}

async function writeGeneratedFile(
  container: WebContainer,
  workspace: ActionRunnerWorkspace,
  relativePath: string,
  requestedPath: string,
  content: string,
): Promise<void> {
  assertNotLocalSecretFilePath(relativePath);
  assertNotInternalGhostbuildFilePath(relativePath);
  const folder = nodePath.dirname(relativePath).replace(/\/+$/g, '');
  if (folder !== '.') {
    await container.fs.mkdir(folder, { recursive: true });
  }
  assertValidGeneratedPackageJson(relativePath, content);
  await container.fs.writeFile(relativePath, content);
  workspace.setGeneratedFileContent(requestedPath, content);
}

function assertNotInternalGhostbuildFilePath(filePath: string): void {
  if (/(^|\/)\.ghost(?:[-.]|$)/.test(filePath)) {
    throw new Error(
      'Ghostbuild internal check files cannot be written. Implement the requested app in /home/project/src/routes/index.tsx instead.',
    );
  }
}

export function isFileMutationTool(toolName: string): boolean {
  return toolName === 'edit' || toolName === 'writeFile';
}

export function isFileTool(toolName: string): boolean {
  return toolName === 'view' || isFileMutationTool(toolName);
}
