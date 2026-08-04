import { createdAtMillis, getToolInvocation, type GhostbuildMessage } from './ai-compat.js';
import { PREWARM_PATHS } from './constants.js';
import type { EditorDocument, FileMap } from './types.js';
import { renderFile } from './utils/renderFile.js';
import { type AbsolutePath, getAbsolutePath } from './utils/workDir.js';

const MAX_RELEVANT_FILES = 16;
const MAX_PROJECT_PATHS = 200;

interface ParsedAssistantMessage {
  filesTouched: Map<AbsolutePath, number>;
}

export class RelevantFilesContext {
  #assistantMessages = new WeakMap<GhostbuildMessage, ParsedAssistantMessage>();

  constructor(
    private readonly getCurrentDocument: () => EditorDocument | undefined,
    private readonly getFiles: () => FileMap,
    private readonly getUserWrites: () => Map<AbsolutePath, number>,
  ) {}

  reset(): void {
    this.#assistantMessages = new WeakMap();
  }

  build(messages: GhostbuildMessage[], id: string, maximumCharacters: number): GhostbuildMessage {
    const currentDocument = this.getCurrentDocument();
    const files = this.getFiles();
    const allPaths = Object.keys(files).sort();
    const lastUsed = this.collectLastUsedPaths(messages, files);

    for (const [filePath, timestamp] of this.getUserWrites()) {
      lastUsed.set(filePath, Math.max(lastUsed.get(filePath) ?? 0, timestamp));
    }
    if (currentDocument) {
      lastUsed.delete(currentDocument.filePath);
    }

    const content = createBoundedRelevantFilesContent({
      currentDocument,
      files,
      lastUsed,
      allPaths,
      maximumCharacters,
    });
    return content ? makeRelevantFilesMessage(content, id) : emptyUserMessage(id);
  }

  #collectPrewarmPaths(files: FileMap): Map<AbsolutePath, number> {
    const lastUsed = new Map<AbsolutePath, number>();
    for (const filePath of PREWARM_PATHS) {
      const absolutePath = filePath as AbsolutePath;
      if (files[absolutePath]) {
        lastUsed.set(absolutePath, 0);
      }
    }
    return lastUsed;
  }

  private collectLastUsedPaths(messages: GhostbuildMessage[], files: FileMap): Map<AbsolutePath, number> {
    const lastUsed = this.#collectPrewarmPaths(files);
    let partCounter = 0;
    for (const message of messages) {
      const parsed = this.parseAssistantMessage(message);
      if (parsed) {
        for (const [filePath, partIndex] of parsed.filesTouched) {
          if (files[filePath]?.type === 'file') {
            lastUsed.set(filePath, (createdAtMillis(message) ?? partCounter) + partIndex);
          }
        }
      }
      partCounter += message.parts.length;
    }
    return lastUsed;
  }

  private parseAssistantMessage(message: GhostbuildMessage): ParsedAssistantMessage | null {
    if (message.role !== 'assistant') {
      return null;
    }
    const cached = this.#assistantMessages.get(message);
    if (cached) {
      return cached;
    }
    const filesTouched = new Map<AbsolutePath, number>();
    message.parts.forEach((part, partIndex) => {
      const invocation = getToolInvocation(part);
      if (!invocation || invocation.state === 'input-streaming') {
        return;
      }
      const filePath = invocationFilePath(invocation);
      if (filePath) {
        filesTouched.set(getAbsolutePath(filePath), partIndex);
      }
    });
    const parsed = { filesTouched };
    this.#assistantMessages.set(message, parsed);
    return parsed;
  }
}

function invocationFilePath(invocation: NonNullable<ReturnType<typeof getToolInvocation>>): string | undefined {
  switch (invocation.toolName) {
    case 'read':
    case 'edit':
    case 'write': {
      const args = invocation.input as { path?: unknown } | null;
      return args && typeof args === 'object' && typeof args.path === 'string' ? args.path : undefined;
    }
    default:
      return undefined;
  }
}

function createBoundedRelevantFilesContent(args: {
  currentDocument: EditorDocument | undefined;
  files: FileMap;
  lastUsed: Map<AbsolutePath, number>;
  allPaths: string[];
  maximumCharacters: number;
}): string {
  const heading = 'Relevant workspace context:\n';
  const contentBudget = Math.max(0, Math.trunc(args.maximumCharacters) - heading.length);
  const sections: string[] = [];
  let size = 0;
  let fileCount = 0;

  const append = (section: string): boolean => {
    const separatorSize = sections.length ? 2 : 0;
    if (size + separatorSize + section.length > contentBudget) {
      return false;
    }
    sections.push(section);
    size += separatorSize + section.length;
    return true;
  };

  if (args.currentDocument && !args.currentDocument.isBinary) {
    const section = renderFileContext(args.currentDocument.filePath, args.currentDocument.value);
    if (append(section)) {
      fileCount++;
    }
  }

  for (const [filePath] of Array.from(args.lastUsed.entries()).sort((a, b) => b[1] - a[1])) {
    if (fileCount >= MAX_RELEVANT_FILES) {
      break;
    }
    const entry = args.files[filePath];
    if (entry?.type !== 'file' || entry.isBinary) {
      continue;
    }
    if (append(renderFileContext(filePath, entry.content))) {
      fileCount++;
    }
  }

  const remaining = contentBudget - size - (sections.length ? 2 : 0);
  const pathSummary = renderPathSummary(args.allPaths, remaining);
  if (pathSummary) {
    append(pathSummary);
  }

  return sections.length ? `${heading}${sections.join('\n\n')}` : '';
}

function renderFileContext(filePath: string, content: string): string {
  return `File ${JSON.stringify(filePath)}:\n${renderFile(content)}`;
}

function renderPathSummary(allPaths: string[], maximumCharacters: number): string {
  if (!allPaths.length || maximumCharacters <= 0) {
    return '';
  }
  const header = 'Project paths:';
  if (header.length > maximumCharacters) {
    return '';
  }
  const lines = [header];
  let size = header.length;
  let included = 0;
  for (const filePath of allPaths.slice(0, MAX_PROJECT_PATHS)) {
    const line = `\n- ${filePath}`;
    if (size + line.length > maximumCharacters) {
      break;
    }
    lines.push(line);
    size += line.length;
    included++;
  }
  if (included === 0) {
    return '';
  }
  let omitted = allPaths.length - included;
  let suffix = omitted > 0 ? `\n- ... ${omitted} more paths (use read to inspect)` : '';
  while (suffix && lines.length > 1 && size + suffix.length > maximumCharacters) {
    const removed = lines.pop();
    size -= removed?.length ?? 0;
    included--;
    omitted = allPaths.length - included;
    suffix = `\n- ... ${omitted} more paths (use read to inspect)`;
  }
  if (suffix && size + suffix.length <= maximumCharacters) {
    lines.push(suffix);
  }
  return lines.join('');
}

function makeRelevantFilesMessage(content: string, id: string): GhostbuildMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text: content }],
  };
}

function emptyUserMessage(id: string): GhostbuildMessage {
  return { id, role: 'user', parts: [] };
}
