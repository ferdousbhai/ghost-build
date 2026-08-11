import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCloudflareSkillAudit = vi.hoisted(() => vi.fn());
const runOpenRouterCanary = vi.hoisted(() => vi.fn());

vi.mock('./upstream-skill-audit.server', () => ({ runCloudflareSkillAudit, runOpenRouterCanary }));

import { runRecordedUpstreamMonitor } from './upstream-monitor.server';

describe('durable upstream monitor receipts', () => {
  beforeEach(() => {
    runCloudflareSkillAudit.mockReset();
    runOpenRouterCanary.mockReset().mockResolvedValue({
      model: '~deepseek/deepseek-v4-flash-latest',
      authorized: true,
      endpointCount: 1,
    });
  });

  it('records attention when the official inventory discovers a new manually admitted skill', async () => {
    runCloudflareSkillAudit.mockResolvedValue(audit({ addedSkills: ['skills/new'] }));
    const database = receiptDatabase();

    await runRecordedUpstreamMonitor({ DB: database.db } as Env);

    expect(database.binds[0]?.[1]).toBe('attention');
    expect(JSON.parse(String(database.binds[0]?.[4]))).toMatchObject({
      audit: { addedSkills: ['skills/new'] },
      canary: { authorized: true },
    });
    expect(database.queries[1]).toContain('LIMIT 104');
  });

  it('records a bounded error receipt and rethrows when the model canary fails', async () => {
    runOpenRouterCanary.mockRejectedValue(new Error('model unavailable'));
    const database = receiptDatabase();

    await expect(runRecordedUpstreamMonitor({ DB: database.db } as Env)).rejects.toThrow('model unavailable');

    expect(database.binds[0]?.[1]).toBe('error');
    expect(database.binds[0]?.[5]).toBe('model unavailable');
    expect(runCloudflareSkillAudit).not.toHaveBeenCalled();
  });
});

function audit(overrides: Record<string, unknown> = {}) {
  return {
    repository: 'cloudflare/skills',
    reviewedRevision: 'a'.repeat(40),
    headRevision: 'b'.repeat(40),
    addedSkills: [],
    removedSkills: [],
    changedTrackedFiles: [],
    assessment: null,
    requiresManualReview: false,
    ...overrides,
  };
}

function receiptDatabase() {
  const queries: string[] = [];
  const binds: unknown[][] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...values: unknown[]) {
          binds.push(values);
          return { query, values };
        },
        query,
      };
    },
    batch: vi.fn(async () => []),
  } as unknown as D1Database;
  return { db, queries, binds };
}
