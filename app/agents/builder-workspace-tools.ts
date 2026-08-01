import type { FileMap } from 'ghostbuild-agent/types';
import type { AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { editToolParameters } from 'ghostbuild-agent/tools/edit';
import { listFilesParameters } from 'ghostbuild-agent/tools/listFiles';
import { searchTextParameters } from 'ghostbuild-agent/tools/searchText';
import { viewParameters } from 'ghostbuild-agent/tools/view';
import { writeFileParameters } from 'ghostbuild-agent/tools/writeFile';
import { toolSuccess, type GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { path as nodePath } from 'ghostbuild-agent/utils/path';
import {
  continuationCursor,
  continuationOffset,
  pageCoverage,
  textPage,
} from '~/lib/runtime/action-runner/bounded-pagination';
import { runListFiles, runSearchText } from '~/lib/runtime/action-runner/project-navigation';
import { contentRevision, queryFingerprint } from '~/lib/runtime/action-runner/revision';
import { BuilderWorkspaceConflictError } from './builder-workspace';
import type { BuilderWorkspaceApi, BuilderWorkspaceFileMetadata } from './builder-workspace-api';
import type { ServerWorkspaceToolName } from './builder-workspace-types';
import { normalizeProjectPath } from '~/lib/runtime/action-runner/project-path';
import { isRepositoryRetrievalPath } from '~/lib/runtime/action-runner/repository-path-policy';

const MAX_SERVER_SEARCH_TEXT_BYTES = 24 * 1024 * 1024;
type WorkspaceFileMetadata = BuilderWorkspaceFileMetadata;

export async function executeBuilderWorkspaceTool(args: {
  workspace: BuilderWorkspaceApi;
  toolCallId: string;
  toolName: ServerWorkspaceToolName;
  input: unknown;
  abortSignal?: AbortSignal;
}): Promise<GhostbuildToolResult> {
  if (args.toolName === 'edit') {
    return runEdit(args.workspace, args.toolCallId, args.input);
  }
  if (args.toolName === 'writeFile') {
    return runWriteFile(args.workspace, args.toolCallId, args.input);
  }
  return args.workspace.executeToolOnce(args.toolCallId, args.toolName, args.input, async () => {
    args.abortSignal?.throwIfAborted();
    const startingRevision = args.workspace.getState().revision;
    let result: GhostbuildToolResult;
    switch (args.toolName) {
      case 'view':
        result = await runView(args.workspace, args.input, startingRevision);
        break;
      case 'listFiles': {
        const listedFiles = args.workspace.listFiles();
        result = await runListFiles({
          input: listFilesParameters.parse(args.input),
          files: workspaceFileMap(listedFiles),
          abortSignal: args.abortSignal,
        });
        break;
      }
      case 'searchText': {
        const input = searchTextParameters.parse(args.input);
        result = await runSearchText({
          input,
          files: await searchableWorkspaceFileMap(args.workspace, input, args.abortSignal),
          abortSignal: args.abortSignal,
        });
        break;
      }
      case 'edit':
      case 'writeFile':
        throw new Error('Workspace mutation tool was routed through the read-only executor.');
    }
    if (args.workspace.getState().revision !== startingRevision) {
      throw new BuilderWorkspaceConflictError(args.workspace.getState());
    }
    return withWorkspaceRevision(result, startingRevision);
  });
}

async function runView(
  workspace: BuilderWorkspaceApi,
  input: unknown,
  workspaceRevision: number,
): Promise<GhostbuildToolResult> {
  const parsed = viewParameters.parse(input);
  const absolutePath = normalizeProjectPath(parsed.path).absolutePath;
  const directory = directoryEntries(workspace.listFiles(), absolutePath);
  if (directory) {
    const content = `Directory:\n${directory
      .map((entry) => `- ${entry.name} (${entry.type === 'directory' ? 'dir' : 'file'})`)
      .join('\n')}`;
    return toolSuccess(`Returned ${directory.length} entries from ${absolutePath}.`, {
      path: absolutePath,
      content,
      entries: directory,
      workspaceRevision,
    });
  }
  const file = await workspace.readText(absolutePath);
  const totalLines = file.content.split('\n').length;
  const [requestedStart, requestedEnd] = parsed.view_range;
  if (requestedStart > totalLines) {
    throw new Error(`Requested line ${requestedStart}, but ${file.path} has ${totalLines} lines.`);
  }
  const end = Math.min(requestedEnd, totalLines + 1);
  const selectedLines = file.content.split('\n').slice(requestedStart - 1, end - 1);
  const selected = `${selectedLines.join('\n')}${end <= totalLines ? '\n' : ''}`;
  const revision = await contentRevision(`${totalLines}\0${selected}`);
  const fingerprint = await queryFingerprint({
    tool: 'view',
    absolutePath: file.path,
    requestedStart,
    end,
  });
  const page = textPage(selected, continuationOffset(parsed.cursor, { revision, fingerprint }));
  const nextCursor = page.complete ? undefined : continuationCursor(revision, fingerprint, page.end);
  const location = textLocation(selected, page.start, requestedStart);
  return toolSuccess(
    `Returned characters ${page.start}-${page.end} of ${page.total} for lines ${requestedStart}-${end - 1} from ${file.path}.`,
    {
      totalLines,
      pageLineStart: location.line,
      pageColumnStart: location.column,
      content: page.content,
      fileRevision: file.sha256,
      workspaceRevision,
    },
    pageCoverage(page, nextCursor),
  );
}

function directoryEntries(
  metadata: readonly WorkspaceFileMetadata[],
  directoryPath: string,
): Array<{ name: string; path: string; type: 'directory' | 'file' }> | undefined {
  const prefix = `${directoryPath}/`;
  const entries = new Map<string, { name: string; path: string; type: 'directory' | 'file' }>();
  for (const file of metadata) {
    if (!file.path.startsWith(prefix)) {
      continue;
    }
    const relativePath = file.path.slice(prefix.length);
    const [name, ...descendants] = relativePath.split('/');
    if (!name) {
      continue;
    }
    const type = descendants.length > 0 ? 'directory' : 'file';
    const existing = entries.get(name);
    if (!existing || type === 'directory') {
      entries.set(name, {
        name,
        path: `${directoryPath}/${name}`,
        type,
      });
    }
  }
  if (entries.size === 0) {
    return undefined;
  }
  return [...entries.values()].sort(
    (left, right) =>
      Number(left.type === 'file') - Number(right.type === 'file') || left.name.localeCompare(right.name),
  );
}

async function runEdit(
  workspace: BuilderWorkspaceApi,
  toolCallId: string,
  input: unknown,
): Promise<GhostbuildToolResult> {
  const parsed = editToolParameters.parse(input);
  const file = await workspace.readText(parsed.path);
  const replacements = prepareReplacements(file.content, parsed.edits);
  let content = file.content;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    content = `${content.slice(0, replacement.start)}${replacement.newText}${content.slice(replacement.end)}`;
  }
  return workspace.commitTextTool({
    toolCallId,
    toolName: 'edit',
    toolArgs: input,
    path: file.path,
    content,
    expectedFileSha256: file.sha256,
    result: ({ path, bytes, changed, workspaceRevision }) =>
      toolSuccess(`Applied ${replacements.length} exact replacements to ${path}.`, {
        path,
        replacements: replacements.map(({ start, end }) => ({
          startLine: lineNumberAt(file.content, start),
          endLine: lineNumberAt(file.content, end),
        })),
        bytes,
        changed,
        workspaceRevision,
      }),
  });
}

async function runWriteFile(
  workspace: BuilderWorkspaceApi,
  toolCallId: string,
  input: unknown,
): Promise<GhostbuildToolResult> {
  const parsed = writeFileParameters.parse(input);
  return workspace.commitTextTool({
    toolCallId,
    toolName: 'writeFile',
    toolArgs: input,
    path: parsed.path,
    content: parsed.content,
    result: ({ path, bytes, changed, workspaceRevision }) =>
      toolSuccess(`Wrote the complete contents of ${path}.`, {
        path,
        bytes,
        changed,
        workspaceRevision,
      }),
  });
}

function workspaceFileMap(metadata: readonly WorkspaceFileMetadata[]): FileMap {
  const files = {} as FileMap;
  for (const file of metadata) {
    addParentFolders(files, file.path);
    files[file.path as AbsolutePath] = {
      type: 'file',
      content: '',
      isBinary: file.encoding !== 'utf8',
    };
  }
  return files;
}

async function searchableWorkspaceFileMap(
  workspace: BuilderWorkspaceApi,
  input: ReturnType<typeof searchTextParameters.parse>,
  abortSignal?: AbortSignal,
): Promise<FileMap> {
  const metadata = workspace.listFiles();
  const files = workspaceFileMap(metadata);
  const basePath = normalizeProjectPath(input.path).absolutePath;
  const extensions = input.fileExtensions?.map((extension) => `.${extension.replace(/^\./, '').toLowerCase()}`);
  let selectedBytes = 0;
  for (const fileMetadata of metadata) {
    abortSignal?.throwIfAborted();
    if (
      fileMetadata.encoding !== 'utf8' ||
      !isRepositoryRetrievalPath(fileMetadata.path, false) ||
      (fileMetadata.path !== basePath && !fileMetadata.path.startsWith(`${basePath}/`)) ||
      (extensions && !extensions.includes(nodePath.extname(fileMetadata.path).toLowerCase()))
    ) {
      continue;
    }
    selectedBytes += fileMetadata.size;
    if (selectedBytes > MAX_SERVER_SEARCH_TEXT_BYTES) {
      throw new Error(
        `The search scope exceeds ${MAX_SERVER_SEARCH_TEXT_BYTES} text bytes. Use a narrower path or extension filter.`,
      );
    }
    const file = await workspace.readText(fileMetadata.path);
    files[fileMetadata.path as AbsolutePath] = {
      type: 'file',
      content: file.content,
      isBinary: false,
    };
  }
  return files;
}

function addParentFolders(files: FileMap, filePath: string): void {
  let parent = nodePath.dirname(filePath);
  while (parent.startsWith('/home/project/') && parent !== '/home/project') {
    files[parent as AbsolutePath] = { type: 'folder' };
    parent = nodePath.dirname(parent);
  }
}

function withWorkspaceRevision(result: GhostbuildToolResult, workspaceRevision: number): GhostbuildToolResult {
  const data =
    result.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? { ...result.data, workspaceRevision }
      : { value: result.data, workspaceRevision };
  return { ...result, data };
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
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
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
