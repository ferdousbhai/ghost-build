import type { WebContainer } from '@webcontainer/api';
import { path as nodePath } from 'ghostbuild-agent/utils/path';
import { unreachable } from 'ghostbuild-agent/utils/unreachable';
import { viewParameters } from 'ghostbuild-agent/tools/view';
import { editToolInputParameters } from 'ghostbuild-agent/tools/edit';
import { writeFileParameters } from 'ghostbuild-agent/tools/writeFile';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { readPath } from '~/utils/fileUtils';
import { assertNotLocalSecretFilePath } from '~/utils/secretFiles';
import { assertValidGeneratedPackageJson } from '~/utils/generatedPackageManifest';
import { assertSafeGeneratedPnpmWorkspace } from '~/utils/generatedPnpmWorkspace';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { toolSuccess } from 'ghostbuild-agent/tool-result';
import type { ActionRunnerWorkspace, ActionState } from './types';
import { continuationCursor, continuationOffset, pageCoverage, textPage } from './bounded-pagination';
import { normalizeProjectPath } from './project-path';
import { contentRevision, queryFingerprint } from './revision';

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

export async function runFileTool(
  invocation: GhostbuildToolInvocation,
  container: WebContainer,
  workspace: ActionRunnerWorkspace,
) {
  switch (invocation.toolName) {
    case 'view': {
      const args = viewParameters.parse(invocation.args);
      const { absolutePath, relativePath } = normalizeProjectPath(args.path);
      assertNotLocalSecretFilePath(relativePath);
      const file = await readPath(container, relativePath);
      if (file.type === 'directory') {
        throw new Error(`${absolutePath} is a directory. Use listFiles to inspect directories.`);
      }
      const totalLines = file.content.split('\n').length;
      const [requestedStart, requestedEnd] = args.view_range;
      if (requestedStart > totalLines) {
        throw new Error(`Requested line ${requestedStart}, but ${absolutePath} has ${totalLines} lines.`);
      }
      const end = Math.min(requestedEnd, totalLines + 1);
      const selectedLines = file.content.split('\n').slice(requestedStart - 1, end - 1);
      const selected = `${selectedLines.join('\n')}${end <= totalLines ? '\n' : ''}`;
      const revision = await contentRevision(`${totalLines}\0${selected}`);
      const fingerprint = await queryFingerprint({ tool: 'view', absolutePath, requestedStart, end });
      const page = textPage(selected, continuationOffset(args.cursor, { revision, fingerprint }));
      const nextCursor = page.complete ? undefined : continuationCursor(revision, fingerprint, page.end);
      const location = textLocation(selected, page.start, requestedStart);
      return toolSuccess(
        `Returned characters ${page.start}-${page.end} of ${page.total} for lines ${requestedStart}-${end - 1} from ${absolutePath}.`,
        {
          totalLines,
          pageLineStart: location.line,
          pageColumnStart: location.column,
          content: page.content,
        },
        pageCoverage(page, nextCursor),
      );
    }
    case 'edit': {
      const args = editToolInputParameters.parse(invocation.args);
      const { absolutePath, relativePath } = normalizeProjectPath(args.path);
      assertNotLocalSecretFilePath(relativePath);
      const file = await readPath(container, relativePath);
      if (file.type !== 'file') {
        throw new Error('Expected a file');
      }
      const replacements = prepareReplacements(file.content, args.edits);
      let content = file.content;
      for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
        content = `${content.slice(0, replacement.start)}${replacement.newText}${content.slice(replacement.end)}`;
      }
      await writeGeneratedFile(container, workspace, relativePath, absolutePath, content);
      return toolSuccess(`Applied ${replacements.length} exact replacements to ${absolutePath}.`, {
        path: absolutePath,
        replacements: replacements.map(({ start, end }) => ({
          startLine: lineNumberAt(file.content, start),
          endLine: lineNumberAt(file.content, end),
        })),
        bytes: new TextEncoder().encode(content).byteLength,
      });
    }
    case 'writeFile': {
      const args = writeFileParameters.parse(invocation.args);
      const { absolutePath, relativePath } = normalizeProjectPath(args.path);
      await writeGeneratedFile(container, workspace, relativePath, absolutePath, args.content);
      return toolSuccess(`Wrote the complete contents of ${absolutePath}.`, {
        path: absolutePath,
        bytes: new TextEncoder().encode(args.content).byteLength,
      });
    }
    default:
      throw new Error(`Expected a file tool, received ${invocation.toolName}`);
  }
}

type PreparedReplacement = { start: number; end: number; newText: string };

function prepareReplacements(content: string, edits: Array<{ old: string; new: string }>): PreparedReplacement[] {
  const replacements = edits.map((edit, index) => {
    const start = content.indexOf(edit.old);
    if (start === -1) {
      throw new Error(`Replacement ${index + 1} did not match the current file.`);
    }
    if (content.indexOf(edit.old, start + edit.old.length) !== -1) {
      throw new Error(`Replacement ${index + 1} matched more than once. Use a more specific old fragment.`);
    }
    return { start, end: start + edit.old.length, newText: edit.new };
  });
  const ordered = [...replacements].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new Error('Edit replacements overlap in the original file. Merge them into one replacement.');
    }
  }
  return replacements;
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function textLocation(content: string, index: number, startingLine: number): { line: number; column: number } {
  const preceding = content.slice(0, index);
  const lines = preceding.split('\n');
  return { line: startingLine + lines.length - 1, column: (lines.at(-1)?.length ?? 0) + 1 };
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

export function isFileMutationTool(toolName: string): boolean {
  return toolName === 'edit' || toolName === 'writeFile';
}

export function isFileTool(toolName: string): boolean {
  return toolName === 'view' || isFileMutationTool(toolName);
}
