import { useState, useMemo, useCallback, type ChangeEvent } from 'react';
import type { ChatHistorySummary } from '~/lib/cloudflare/data-api';
import { useDebounce } from '@uidotdev/usehooks';

interface UseSearchFilterOptions {
  items: ChatHistorySummary[];
  searchFields?: (keyof ChatHistorySummary)[];
  debounceMs?: number;
}

const DEFAULT_SEARCH_FIELDS: (keyof ChatHistorySummary)[] = ['description'];

export function useSearchFilter({
  items = [],
  searchFields = DEFAULT_SEARCH_FIELDS,
  debounceMs = 300,
}: UseSearchFilterOptions) {
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearchQuery = useDebounce(searchQuery, debounceMs);

  const handleSearchChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
  }, []);

  const filteredItems = useMemo(() => {
    const query = debouncedSearchQuery.trim().toLowerCase();
    if (!query) {
      return items;
    }

    return items.filter((item) =>
      searchFields.some((field) => {
        const value = item[field];
        return value !== undefined && value.toLowerCase().includes(query);
      }),
    );
  }, [items, debouncedSearchQuery, searchFields]);

  return {
    filteredItems,
    handleSearchChange,
  };
}
