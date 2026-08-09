import { docDescriptions, docKeys, docs, type DocKey } from './references/index.js';

export const VIRTUAL_DOCS_ROOT = '/home/project/.ghost/docs';

export function isVirtualDocPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === VIRTUAL_DOCS_ROOT || normalized.startsWith(`${VIRTUAL_DOCS_ROOT}/`);
}
const MAX_DOC_LINES = 2_000;
const MAX_DOC_BYTES = 256 * 1024;

type ReadInput = { path: string; offset?: number; limit?: number };
type ReadResult = {
  content: [{ type: 'text'; text: string }];
  details: {
    virtual: true;
    path: string;
    offset: number;
    limit?: number;
    totalLines: number;
    totalBytes: number;
  };
};

/** Read the immutable Ghostbuild guidance overlay through the normal read tool. */
export function readVirtualDoc(input: ReadInput): ReadResult | null {
  const path = normalizePath(input.path);
  if (!isVirtualDocPath(path)) {
    return null;
  }

  const { content, resolvedPath } = resolveVirtualDoc(path);
  const lines = content.split('\n');
  const offset = input.offset ?? 1;
  const limit = input.limit;
  if (!Number.isInteger(offset) || offset < 1) {
    throw new Error('Virtual documentation offset must be a positive line number.');
  }
  if (offset > lines.length) {
    throw new Error(`Offset ${offset} is beyond the end of ${resolvedPath} (${lines.length} lines total).`);
  }

  const requestedEnd = Math.min(lines.length, offset - 1 + (limit ?? lines.length));
  const selected: string[] = [];
  let selectedBytes = 0;
  for (let index = offset - 1; index < requestedEnd && selected.length < MAX_DOC_LINES; index += 1) {
    const line = lines[index]!;
    const nextBytes = byteLength(line) + (selected.length > 0 ? 1 : 0);
    if (selected.length > 0 && selectedBytes + nextBytes > MAX_DOC_BYTES) {
      break;
    }
    selected.push(line);
    selectedBytes += nextBytes;
  }
  let text = selected.join('\n');
  const end = offset + selected.length - 1;
  if (end < lines.length) {
    text += `\n\n[${lines.length - end} more lines. Use offset=${end + 1} to continue.]`;
  }

  return {
    content: [{ type: 'text', text }],
    details: {
      virtual: true,
      path: resolvedPath,
      offset,
      ...(limit === undefined ? {} : { limit }),
      totalLines: lines.length,
      totalBytes: byteLength(content),
    },
  };
}

function resolveVirtualDoc(path: string): { resolvedPath: string; content: string } {
  if (path === VIRTUAL_DOCS_ROOT || path === `${VIRTUAL_DOCS_ROOT}/index.md`) {
    const index = [
      '# Ghostbuild documentation',
      '',
      'Read one of these immutable guidance files when the implementation needs platform or design guidance:',
      '',
      ...docKeys.map((key) => `- ${key}.md — ${docDescriptions[key]}`),
    ].join('\n');
    return { resolvedPath: `${VIRTUAL_DOCS_ROOT}/index.md`, content: index };
  }

  const match = new RegExp(`^${escapeRegExp(VIRTUAL_DOCS_ROOT)}/([^/]+)\\.md$`).exec(path);
  const key = match?.[1] as DocKey | undefined;
  if (!key || !docKeys.includes(key)) {
    throw new Error(`Unknown virtual documentation path ${path}. Read ${VIRTUAL_DOCS_ROOT}/index.md first.`);
  }
  return { resolvedPath: `${VIRTUAL_DOCS_ROOT}/${key}.md`, content: docs[key] };
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
