import type { WebContainer } from '@webcontainer/api';
import { path as nodePath } from 'ghostbuild-agent/utils/path';
import { unreachable } from 'ghostbuild-agent/utils/unreachable';
import { assertNotLocalSecretFilePath } from '~/utils/secretFiles';
import { assertValidGeneratedPackageJson } from '~/utils/generatedPackageManifest';
import { assertSafeGeneratedPnpmWorkspace } from '~/utils/generatedPnpmWorkspace';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { ActionRunnerWorkspace, ActionState } from './types';
import { normalizeProjectPath } from './project-path';

const logger = createScopedLogger('ActionRunner.FileTools');

export async function runStreamedFileAction(
  action: ActionState,
  container: WebContainer,
  workspace: ActionRunnerWorkspace,
): Promise<void> {
  if (action.type !== 'file') {
    unreachable('Expected file action');
  }
  const { absolutePath, relativePath } = normalizeProjectPath(action.filePath);
  await writeGeneratedFile(container, workspace, relativePath, absolutePath, action.content);
  logger.debug(`File written ${relativePath}`);
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
  assertValidGeneratedPackageJson(relativePath, content);
  assertSafeGeneratedPnpmWorkspace(relativePath, content);
  const folder = nodePath.dirname(relativePath).replace(/\/+$/g, '');
  if (folder !== '.') {
    await container.fs.mkdir(folder, { recursive: true });
  }
  await container.fs.writeFile(relativePath, content);
  await workspace.setGeneratedFileContent(requestedPath, content);
}

function assertNotInternalGhostbuildFilePath(filePath: string): void {
  if (/(^|\/)\.ghost(?:[-.]|$)/.test(filePath)) {
    throw new Error(
      'Ghostbuild internal check files cannot be written. Implement the requested app in /home/project/src/routes/index.tsx instead.',
    );
  }
}
