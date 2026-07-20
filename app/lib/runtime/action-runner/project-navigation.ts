import type { FileMap } from 'ghostbuild-agent/types';
import { listFilesParameters } from 'ghostbuild-agent/tools/listFiles';
import { searchTextParameters } from 'ghostbuild-agent/tools/searchText';
import { path as nodePath } from 'ghostbuild-agent/utils/path';
import { toolSuccess } from 'ghostbuild-agent/tool-result';
import { continuationCursor, continuationOffset, pageCoverage, recordPage } from './bounded-pagination';
import { normalizeProjectPath } from './project-path';
import { contentRevision, queryFingerprint } from './revision';
import { isRepositoryRetrievalPath, matchesProjectGlob } from './repository-path-policy';
import type { AbsolutePath } from 'ghostbuild-agent/utils/workDir';

const MAX_SNAPSHOT_RECORDS = 10_000;
const MAX_INLINE_SEARCH_LINE_CHARACTERS = 500;

type ProjectPathRecord = {
  path: string;
  type: 'file' | 'directory';
};

type ProjectSearchRecord = {
  path: string;
  line: number;
  column: number;
  lineCharacters: number;
  lineText?: string;
  fileRevision: string;
  relevance: number;
};

export async function runListFiles(args: { input: unknown; files: FileMap; abortSignal?: AbortSignal }) {
  const input = listFilesParameters.parse(args.input);
  args.abortSignal?.throwIfAborted();
  const basePath = normalizeProjectPath(input.path).absolutePath;
  const records = Object.entries(args.files)
    .filter(
      ([filePath, entry]) =>
        entry !== undefined &&
        isRepositoryRetrievalPath(filePath, entry.type === 'file' && entry.isBinary) &&
        matchesProjectGlob(filePath, input.glob),
    )
    .map(([filePath, entry]) => ({
      absolutePath: filePath,
      relativeToBase: nodePath.relative(basePath, filePath),
      type: entry?.type === 'folder' ? ('directory' as const) : ('file' as const),
    }))
    .filter(({ relativeToBase }) => isDescendant(relativeToBase))
    .filter(({ relativeToBase }) => input.recursive || !relativeToBase.includes('/'))
    .sort((left, right) => left.absolutePath.localeCompare(right.absolutePath))
    .map(({ absolutePath, type }): ProjectPathRecord => ({ path: absolutePath, type }));

  assertSnapshotSize(records.length, 'path', 'Use a narrower listFiles path.');
  args.abortSignal?.throwIfAborted();
  const revision = await contentRevision(JSON.stringify(records));
  const fingerprint = await queryFingerprint({
    tool: 'listFiles',
    basePath,
    recursive: input.recursive,
    glob: input.glob,
  });
  const page = recordPage(records, continuationOffset(input.cursor, { revision, fingerprint }));
  const nextCursor = page.complete ? undefined : continuationCursor(revision, fingerprint, page.end);
  return toolSuccess(
    `Returned paths ${page.start}-${page.end} of ${page.total} under ${basePath}.`,
    { records: page.items },
    pageCoverage(page, nextCursor),
  );
}

export async function runSearchText(args: {
  input: unknown;
  files: FileMap;
  recentFileWrites?: ReadonlyMap<string, number>;
  abortSignal?: AbortSignal;
}) {
  const input = searchTextParameters.parse(args.input);
  args.abortSignal?.throwIfAborted();
  const basePath = normalizeProjectPath(input.path).absolutePath;
  const extensions = input.fileExtensions?.map((extension) => `.${extension.replace(/^\./, '').toLowerCase()}`);
  const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
  const rawRecords: Omit<ProjectSearchRecord, 'fileRevision' | 'relevance'>[] = [];

  for (const [filePath, entry] of Object.entries(args.files).sort(([left], [right]) => left.localeCompare(right))) {
    args.abortSignal?.throwIfAborted();
    if (
      entry?.type !== 'file' ||
      !isRepositoryRetrievalPath(filePath, entry.isBinary) ||
      !isPathWithin(basePath, filePath)
    ) {
      continue;
    }
    if (extensions && !extensions.includes(nodePath.extname(filePath).toLowerCase())) {
      continue;
    }
    const lines = entry.content.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const haystack = input.caseSensitive ? line : line.toLocaleLowerCase();
      let fromIndex = 0;
      while (fromIndex <= haystack.length) {
        const matchIndex = haystack.indexOf(needle, fromIndex);
        if (matchIndex === -1) {
          break;
        }
        rawRecords.push({
          path: filePath,
          line: lineIndex + 1,
          column: matchIndex + 1,
          lineCharacters: line.length,
          ...(line.length <= MAX_INLINE_SEARCH_LINE_CHARACTERS ? { lineText: line } : {}),
        });
        assertSnapshotSize(rawRecords.length, 'match', 'Use a narrower path, extension filter, or query.');
        fromIndex = matchIndex + Math.max(1, needle.length);
      }
    }
  }

  const fileRevisions = await revisionsForMatches(rawRecords, args.files, args.abortSignal);
  const recentRanks = recentFileRanks(args.recentFileWrites);
  const contextTokens = searchContextTokens(`${input.query} ${input.context ?? ''}`);
  const records: ProjectSearchRecord[] = rawRecords
    .map((record) => ({
      ...record,
      fileRevision: fileRevisions.get(record.path) ?? 'unknown',
      relevance: searchRecordRelevance(record, contextTokens, recentRanks.get(record.path)),
    }))
    .sort(compareSearchRecords);
  args.abortSignal?.throwIfAborted();
  const revision = await contentRevision(JSON.stringify(records));
  const fingerprint = await queryFingerprint({
    tool: 'searchText',
    query: input.query,
    basePath,
    caseSensitive: input.caseSensitive,
    extensions,
    context: input.context,
  });
  const page = recordPage(records, continuationOffset(input.cursor, { revision, fingerprint }));
  const nextCursor = page.complete ? undefined : continuationCursor(revision, fingerprint, page.end);
  return toolSuccess(
    `Returned matches ${page.start}-${page.end} of ${page.total} for ${JSON.stringify(input.query)}.`,
    { records: page.items },
    pageCoverage(page, nextCursor),
  );
}

async function revisionsForMatches(
  records: Array<{ path: string }>,
  files: FileMap,
  abortSignal?: AbortSignal,
): Promise<Map<string, string>> {
  const paths = Array.from(new Set(records.map((record) => record.path)));
  const revisions = await Promise.all(
    paths.map(async (filePath) => {
      abortSignal?.throwIfAborted();
      const entry = files[filePath as AbsolutePath];
      const revision = entry?.type === 'file' ? (await contentRevision(entry.content)).slice(0, 16) : 'unknown';
      return [filePath, revision] as const;
    }),
  );
  return new Map(revisions);
}

function recentFileRanks(recentFileWrites: ReadonlyMap<string, number> | undefined): Map<string, number> {
  return new Map(
    Array.from(recentFileWrites ?? [])
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([filePath], index) => [filePath, index]),
  );
}

function searchContextTokens(context: string): string[] {
  return Array.from(new Set(context.toLocaleLowerCase().match(/[a-z0-9_$-]{2,}/g) ?? [])).slice(0, 24);
}

function searchRecordRelevance(
  record: Omit<ProjectSearchRecord, 'fileRevision' | 'relevance'>,
  contextTokens: string[],
  recentRank: number | undefined,
): number {
  const path = record.path.toLocaleLowerCase();
  const line = record.lineText?.toLocaleLowerCase() ?? '';
  let relevance = 0;
  for (const token of contextTokens) {
    if (path.includes(token)) {
      relevance += 6;
    }
    if (line.includes(token)) {
      relevance += 1;
    }
  }
  const trimmed = line.trimStart();
  const declaresContextToken = contextTokens.some((token) =>
    new RegExp(
      `^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|const|let|var|enum)\\s+${escapeRegExp(token)}\\b`,
      'i',
    ).test(trimmed),
  );
  if (declaresContextToken) {
    relevance += 18;
  } else if (/^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\b/.test(trimmed)) {
    relevance += 8;
  } else if (/^(?:import|export)\b/.test(trimmed) || /\brequire\s*\(/.test(trimmed)) {
    relevance += 8;
  }
  if (recentRank !== undefined && recentRank < 6) {
    relevance += 6 - recentRank;
  }
  return relevance;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareSearchRecords(left: ProjectSearchRecord, right: ProjectSearchRecord): number {
  return (
    right.relevance - left.relevance ||
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column
  );
}

function isPathWithin(basePath: string, candidate: string): boolean {
  return candidate === basePath || candidate.startsWith(`${basePath}/`);
}

function isDescendant(relativePath: string): boolean {
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith('../') &&
    !nodePath.isAbsolute(relativePath)
  );
}

function assertSnapshotSize(count: number, recordName: string, guidance: string): void {
  if (count > MAX_SNAPSHOT_RECORDS) {
    throw new Error(`The request produced more than ${MAX_SNAPSHOT_RECORDS} ${recordName} records. ${guidance}`);
  }
}
