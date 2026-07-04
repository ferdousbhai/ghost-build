import { format, isAfter, isThisWeek, isThisYear, isToday, isYesterday, subDays } from 'date-fns';
import type { ChatHistorySummary } from '~/lib/cloudflare/data-api';

type Bin = { category: string; items: ChatHistorySummary[] };

export function binDates(items: ChatHistorySummary[]) {
  const list = [...items].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const bins = new Map<string, Bin>();

  for (const item of list) {
    const category = dateCategory(new Date(item.timestamp));
    let bin = bins.get(category);
    if (!bin) {
      bin = { category, items: [] };
      bins.set(category, bin);
    }
    bin.items.push(item);
  }

  return [...bins.values()];
}

function dateCategory(date: Date) {
  if (isToday(date)) {
    return 'Today';
  }

  if (isYesterday(date)) {
    return 'Yesterday';
  }

  if (isThisWeek(date)) {
    // e.g., "Mon" instead of "Monday"
    return format(date, 'EEE');
  }

  const thirtyDaysAgo = subDays(new Date(), 30);

  if (isAfter(date, thirtyDaysAgo)) {
    return 'Past 30 Days';
  }

  if (isThisYear(date)) {
    // e.g., "Jan" instead of "January"
    return format(date, 'LLL');
  }

  // e.g., "Jan 2023" instead of "January 2023"
  return format(date, 'LLL yyyy');
}
