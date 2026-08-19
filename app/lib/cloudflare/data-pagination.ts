export const DEFAULT_DATA_PAGE_SIZE = 50;
export const MAX_DATA_PAGE_SIZE = 100;
export const MAX_SUBCHAT_INDEX = 10_000;

export type DataPage<Item, Cursor> = {
  items: Item[];
  nextCursor?: Cursor;
};

export type ChatHistoryCursor = {
  timestamp: string;
  rowId: string;
};

export type SubchatCursor = {
  subchatIndex: number;
};

export function boundedDataPageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isSafeInteger(limit)) {
    return DEFAULT_DATA_PAGE_SIZE;
  }
  return Math.min(MAX_DATA_PAGE_SIZE, Math.max(1, limit));
}
