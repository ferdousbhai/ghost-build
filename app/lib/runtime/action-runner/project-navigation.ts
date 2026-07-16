import type { FileMap } from 'ghostbuild-agent/types';
import { listFilesParameters } from 'ghostbuild-agent/tools/listFiles';
import { searchTextParameters } from 'ghostbuild-agent/tools/searchText';
import { path as nodePath } from 'ghostbuild-agent/utils/path';
import { isLocalSecretFilePath } from '~/utils/secretFiles';
import { toolSuccess } from 'ghostbuild-agent/tool-result';
import { continuationCursor, continuationOffset, pageCoverage, recordPage } from './bounded-pagination';
import { normalizeProjectPath } from './project-path';
import { contentRevision, queryFingerprint } from './revision';

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
};

export async function runListFiles(args: { input: unknown; files: FileMap }) {
  const input = listFilesParameters.parse(args.input);
  const basePath = normalizeProjectPath(input.path).absolutePath;
  const records = Object.entries(args.files)
    .filter(([filePath, entry]) => entry !== undefined && !isLocalSecretFilePath(filePath))
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
  const revision = await contentRevision(JSON.stringify(records));
  const fingerprint = await queryFingerprint({ tool: 'listFiles', basePath, recursive: input.recursive });
  const page = recordPage(records, continuationOffset(input.cursor, { revision, fingerprint }));
  const nextCursor = page.complete ? undefined : continuationCursor(revision, fingerprint, page.end);
  return toolSuccess(
    `Returned paths ${page.start}-${page.end} of ${page.total} under ${basePath}.`,
    { records: page.items },
    pageCoverage(page, nextCursor),
  );
}

export async function runSearchText(args: { input: unknown; files: FileMap }) {
  const input = searchTextParameters.parse(args.input);
  const basePath = normalizeProjectPath(input.path).absolutePath;
  const extensions = input.fileExtensions?.map((extension) => `.${extension.replace(/^\./, '').toLowerCase()}`);
  const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
  const records: ProjectSearchRecord[] = [];

  for (const [filePath, entry] of Object.entries(args.files).sort(([left], [right]) => left.localeCompare(right))) {
    if (
      entry?.type !== 'file' ||
      entry.isBinary ||
      isLocalSecretFilePath(filePath) ||
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
        records.push({
          path: filePath,
          line: lineIndex + 1,
          column: matchIndex + 1,
          lineCharacters: line.length,
          ...(line.length <= MAX_INLINE_SEARCH_LINE_CHARACTERS ? { lineText: line } : {}),
        });
        assertSnapshotSize(records.length, 'match', 'Use a narrower path, extension filter, or query.');
        fromIndex = matchIndex + Math.max(1, needle.length);
      }
    }
  }

  const revision = await contentRevision(JSON.stringify(records));
  const fingerprint = await queryFingerprint({
    tool: 'searchText',
    query: input.query,
    basePath,
    caseSensitive: input.caseSensitive,
    extensions,
  });
  const page = recordPage(records, continuationOffset(input.cursor, { revision, fingerprint }));
  const nextCursor = page.complete ? undefined : continuationCursor(revision, fingerprint, page.end);
  return toolSuccess(
    `Returned matches ${page.start}-${page.end} of ${page.total} for ${JSON.stringify(input.query)}.`,
    { records: page.items },
    pageCoverage(page, nextCursor),
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
