import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatHistorySummary } from '~/lib/cloudflare/data-api';
import { binDates } from './date-binning';

function project(timestamp: string, initialId: string): ChatHistorySummary {
  return {
    id: initialId,
    initialId,
    urlId: initialId,
    description: `Project ${initialId}`,
    timestamp,
  };
}

describe('binDates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a full weekday and date for projects from the current week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));

    const bins = binDates([project('2026-07-13T09:00:00Z', 'monday')]);

    expect(bins).toHaveLength(1);
    expect(bins[0]?.category).toMatch(/^Monday, Jul 13$/);
    expect(bins[0]?.items[0]?.description).toBe('Project monday');
  });
});
