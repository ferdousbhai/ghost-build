import type { ToolResultCoverage } from 'ghostbuild-agent/tool-result';

export const TOOL_PAGE_SERIALIZED_CHARACTERS = 12_000;
const TOOL_PAGE_RECORDS = 40;
const CURSOR_HASH_CHARACTERS = 16;

type Page = {
  start: number;
  end: number;
  total: number;
  complete: boolean;
};

type RecordPage<T> = Page & { items: T[] };
type TextPage = Page & { content: string };

export function recordPage<T>(records: T[], start: number): RecordPage<T> {
  assertOffset(start, records.length);
  const maximumEnd = Math.min(start + TOOL_PAGE_RECORDS, records.length);
  let end = start;
  let serializedSize = 2;
  while (end < maximumEnd) {
    const recordSize = (JSON.stringify(records[end]) ?? 'null').length + (end === start ? 0 : 1);
    if (end === start && serializedSize + recordSize > TOOL_PAGE_SERIALIZED_CHARACTERS) {
      throw new Error('A structured result record exceeds the per-page size limit. Narrow the request.');
    }
    if (end > start && serializedSize + recordSize > TOOL_PAGE_SERIALIZED_CHARACTERS) {
      break;
    }
    serializedSize += recordSize;
    end += 1;
  }
  return { items: records.slice(start, end), start, end, total: records.length, complete: end === records.length };
}

export function textPage(content: string, start: number): TextPage {
  assertOffset(start, content.length);
  const end = safeTextEnd(content, start, TOOL_PAGE_SERIALIZED_CHARACTERS);
  return {
    content: content.slice(start, end),
    start,
    end,
    total: content.length,
    complete: end === content.length,
  };
}

export function pageCoverage(page: Page, nextCursor?: string): ToolResultCoverage {
  return {
    complete: page.complete,
    start: page.start,
    end: page.end,
    total: page.total,
    ...(!page.complete && nextCursor ? { nextCursor } : {}),
  };
}

export function continuationOffset(
  cursor: string | undefined,
  expected: { revision: string; fingerprint: string },
): number {
  if (!cursor) {
    return 0;
  }
  const match = cursor.match(/^([a-f0-9]{16})\.([a-f0-9]{16})\.(\d+)$/);
  if (!match) {
    throw new Error('Continuation cursor is invalid. Reuse the exact cursor returned by the previous page.');
  }
  if (match[1] !== expected.revision.slice(0, CURSOR_HASH_CHARACTERS)) {
    throw new Error('The underlying content changed after the previous page. Restart this bounded request.');
  }
  if (match[2] !== expected.fingerprint) {
    throw new Error('The continuation cursor belongs to different tool arguments. Restart this bounded request.');
  }
  return Number(match[3]);
}

export function continuationCursor(revision: string, fingerprint: string, offset: number): string {
  return `${revision.slice(0, CURSOR_HASH_CHARACTERS)}.${fingerprint}.${offset}`;
}

function safeTextEnd(content: string, start: number, maximumSerializedCharacters: number): number {
  let lower = start;
  let upper = Math.min(start + maximumSerializedCharacters, content.length);
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    if (JSON.stringify(content.slice(start, candidate)).length <= maximumSerializedCharacters) {
      lower = candidate;
    } else {
      upper = candidate - 1;
    }
  }
  let end = lower;
  if (end < content.length) {
    const lastNewline = content.lastIndexOf('\n', end - 1);
    if (lastNewline >= start + Math.floor((end - start) / 2)) {
      end = lastNewline + 1;
    }
    const last = content.charCodeAt(end - 1);
    const next = content.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end -= 1;
    }
  }
  if (end === start && start < content.length) {
    throw new Error('A text result character exceeds the per-page size limit.');
  }
  return end;
}

function assertOffset(offset: number, total: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) {
    throw new Error(`Continuation offset ${offset} is outside the complete result size ${total}.`);
  }
}
