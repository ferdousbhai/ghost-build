import { executeDataOperation } from './client';
import { api, type ChatHistorySummary, type SubchatSummary } from './data-api';
import {
  DEFAULT_DATA_PAGE_SIZE,
  MAX_SUBCHAT_INDEX,
  type ChatHistoryCursor,
  type DataPage,
  type SubchatCursor,
} from './data-pagination';

type PageLoader<Item, Cursor> = (cursor: Cursor | undefined) => Promise<DataPage<Item, Cursor>>;

type PageCollectionOptions<Item, Cursor> = {
  signal?: AbortSignal;
  maximumItemsPerPage: number;
  itemKey: (item: Item) => string | number;
  validateItem: (item: unknown) => item is Item;
  validateCursor: (cursor: unknown) => cursor is Cursor;
  cursorAdvances: (previous: Cursor, next: Cursor) => boolean;
  validatePageOrder: (items: Item[], previous: Cursor | undefined, next: Cursor | undefined) => boolean;
};

export async function collectDataPages<Item, Cursor>(
  loadPage: PageLoader<Item, Cursor>,
  options: PageCollectionOptions<Item, Cursor>,
): Promise<Item[]> {
  const items: Item[] = [];
  const seenItemKeys = new Set<string | number>();
  const seenCursorKeys = new Set<string>();
  let cursor: Cursor | undefined;

  for (;;) {
    options.signal?.throwIfAborted();
    const page = await loadPage(cursor);
    options.signal?.throwIfAborted();
    if (!isRecord(page) || !Array.isArray(page.items)) {
      throw new Error('Data pagination returned a malformed page');
    }
    if (page.items.length > options.maximumItemsPerPage) {
      throw new Error('Data pagination returned an oversized page');
    }
    for (const item of page.items) {
      if (!options.validateItem(item)) {
        throw new Error('Data pagination returned a malformed item');
      }
      const key = options.itemKey(item);
      if (seenItemKeys.has(key)) {
        throw new Error('Data pagination returned a duplicate item');
      }
      seenItemKeys.add(key);
      items.push(item);
    }

    if (page.nextCursor === undefined) {
      if (!options.validatePageOrder(page.items, cursor, undefined)) {
        throw new Error('Data pagination returned an out-of-order page');
      }
      return items;
    }
    if (page.items.length === 0 || !options.validateCursor(page.nextCursor)) {
      throw new Error('Data pagination returned a malformed cursor');
    }
    if (!options.validatePageOrder(page.items, cursor, page.nextCursor)) {
      throw new Error('Data pagination returned an out-of-order page');
    }
    if (cursor !== undefined && !options.cursorAdvances(cursor, page.nextCursor)) {
      throw new Error('Data pagination did not advance');
    }

    const cursorKey = stableCursorKey(page.nextCursor);
    if (seenCursorKeys.has(cursorKey)) {
      throw new Error('Data pagination did not advance');
    }
    seenCursorKeys.add(cursorKey);
    cursor = page.nextCursor;
  }
}

export function loadAllChatHistory(sessionId: string, signal?: AbortSignal): Promise<ChatHistorySummary[]> {
  return collectDataPages<ChatHistorySummary, ChatHistoryCursor>(
    (cursor) =>
      executeDataOperation(
        api.messages.getAll,
        {
          sessionId,
          cursor,
          limit: DEFAULT_DATA_PAGE_SIZE,
        },
        { signal },
      ),
    {
      signal,
      maximumItemsPerPage: DEFAULT_DATA_PAGE_SIZE,
      itemKey: (item) => item.initialId,
      validateItem: isChatHistorySummary,
      validateCursor: isChatHistoryCursor,
      cursorAdvances: (previous, next) =>
        next.timestamp < previous.timestamp || (next.timestamp === previous.timestamp && next.rowId < previous.rowId),
      validatePageOrder: (items, previous, next) =>
        isDescendingBy(items, (item) => item.timestamp) &&
        (previous === undefined || items.every((item) => item.timestamp <= previous.timestamp)) &&
        (next === undefined || next.timestamp === items.at(-1)?.timestamp),
    },
  );
}

export function loadAllSubchats(chatId: string, sessionId: string, signal?: AbortSignal): Promise<SubchatSummary[]> {
  return collectDataPages<SubchatSummary, SubchatCursor>(
    (cursor) =>
      executeDataOperation(
        api.subchats.get,
        {
          chatId,
          sessionId,
          cursor,
          limit: DEFAULT_DATA_PAGE_SIZE,
        },
        { signal },
      ),
    {
      signal,
      maximumItemsPerPage: DEFAULT_DATA_PAGE_SIZE,
      itemKey: (item) => item.subchatIndex,
      validateItem: isSubchatSummary,
      validateCursor: isSubchatCursor,
      cursorAdvances: (previous, next) => next.subchatIndex > previous.subchatIndex,
      validatePageOrder: (items, previous, next) =>
        isStrictlyAscendingBy(items, (item) => item.subchatIndex) &&
        (previous === undefined || items.every((item) => item.subchatIndex > previous.subchatIndex)) &&
        (next === undefined || next.subchatIndex === items.at(-1)?.subchatIndex),
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isChatHistorySummary(value: unknown): value is ChatHistorySummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.initialId) &&
    isStoredChatTimestamp(value.timestamp) &&
    (value.urlId === undefined || isNonEmptyString(value.urlId)) &&
    (value.description === undefined || typeof value.description === 'string')
  );
}

function isSubchatSummary(value: unknown): value is SubchatSummary {
  if (
    !isRecord(value) ||
    !isSafeNonnegativeInteger(value.subchatIndex) ||
    value.subchatIndex > MAX_SUBCHAT_INDEX ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.description !== undefined && typeof value.description !== 'string') ||
    !isRecord(value.transcript)
  ) {
    return false;
  }
  return (
    isNonEmptyString(value.transcript.agentName) &&
    isSafeNonnegativeInteger(value.transcript.generation) &&
    value.transcript.subchatIndex === value.subchatIndex
  );
}

function isChatHistoryCursor(value: unknown): value is ChatHistoryCursor {
  return (
    hasExactKeys(value, ['rowId', 'timestamp']) &&
    isNonEmptyString(value.rowId) &&
    value.rowId.length <= 512 &&
    isStoredChatTimestamp(value.timestamp)
  );
}

function isSubchatCursor(value: unknown): value is SubchatCursor {
  return (
    hasExactKeys(value, ['subchatIndex']) &&
    isSafeNonnegativeInteger(value.subchatIndex) &&
    value.subchatIndex <= MAX_SUBCHAT_INDEX
  );
}

function hasExactKeys<Key extends string>(value: unknown, keys: readonly Key[]): value is Record<Key, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === keys.length && keys.every((key, index) => actualKeys[index] === key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStoredChatTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function stableCursorKey(cursor: unknown): string {
  try {
    const key = JSON.stringify(cursor);
    if (key === undefined) {
      throw new Error();
    }
    return key;
  } catch {
    throw new Error('Data pagination returned a malformed cursor');
  }
}

function isDescendingBy<Item>(items: Item[], select: (item: Item) => string): boolean {
  return items.every((item, index) => index === 0 || select(items[index - 1]) >= select(item));
}

function isStrictlyAscendingBy<Item>(items: Item[], select: (item: Item) => number): boolean {
  return items.every((item, index) => index === 0 || select(items[index - 1]) < select(item));
}
