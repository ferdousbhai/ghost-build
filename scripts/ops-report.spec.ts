import { describe, expect, it } from 'vitest';
import {
  classifyConnections,
  collectReport,
  describeReconcileRun,
  describeSkillSyncRun,
  describeDailyJobs,
  describeWorkspaceRuntime,
  describeWranglerFailure,
  formatDuration,
  formatRelativeTime,
  headlineFor,
  parseD1Response,
  renderReport,
} from './ops-report.mjs';

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CURRENT_RUNTIME = 'a'.repeat(64);
const OLD_RUNTIME = 'b'.repeat(64);

describe('relative time', () => {
  it('names sub-minute ages instead of printing "0m ago"', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 1_000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 59_999, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - MINUTE, NOW)).toBe('1m ago');
  });

  it('never renders a negative age when a stored clock runs ahead', () => {
    expect(formatRelativeTime(NOW + 5_000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW + 5 * MINUTE, NOW)).toBe('5m from now');
    expect(formatRelativeTime(NOW + 3 * DAY, NOW)).toBe('3d from now');
  });

  it('says what is missing rather than inventing a time', () => {
    expect(formatRelativeTime(null, NOW)).toBe('never');
    expect(formatRelativeTime(undefined, NOW)).toBe('never');
    expect(formatRelativeTime(Number.NaN, NOW)).toBe('never');
    expect(formatRelativeTime('2026-08-18', NOW)).toBe('never');
    expect(formatRelativeTime(0, NOW)).toBe('never');
    expect(formatRelativeTime(-1, NOW)).toBe('never');
    expect(formatRelativeTime(null, NOW, { missing: 'at an unrecorded time' })).toBe('at an unrecorded time');
    expect(formatRelativeTime(null, NOW, { missing: null })).toBeNull();
    expect(formatRelativeTime(NOW, Number.NaN)).toBe('never');
  });

  it('steps through minutes, hours, and days without ambiguous units', () => {
    expect(formatRelativeTime(NOW - 59 * MINUTE, NOW)).toBe('59m ago');
    expect(formatRelativeTime(NOW - 60 * MINUTE, NOW)).toBe('1h ago');
    expect(formatRelativeTime(NOW - 47 * HOUR, NOW)).toBe('47h ago');
    expect(formatRelativeTime(NOW - 48 * HOUR, NOW)).toBe('2d ago');
    expect(formatRelativeTime(NOW - 400 * DAY, NOW)).toBe('400d ago');
    expect(formatDuration(-1)).toBe('an unknown span');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('an unknown span');
  });
});

describe('connection health classification', () => {
  it('is healthy only when every connection is active and holds a credential', () => {
    const healthy = classifyConnections([{ status: 'active', count: 2, missing_credential: 0 }]);
    expect(healthy.level).toBe('ok');
    expect(healthy.sentence).toBe('All 2 Cloudflare connections are active.');
  });

  it('treats a revoked or errored connection as broken', () => {
    const result = classifyConnections([
      { status: 'active', count: 1, missing_credential: 0 },
      { status: 'revoked', count: 1, missing_credential: 0 },
      { status: 'linking', count: 1, missing_credential: 0 },
    ]);
    expect(result.level).toBe('error');
    expect(result.sentence).toBe('1 of 3 Cloudflare connections is active; 1 revoked or errored, 1 still linking.');
  });

  it('treats an active connection with no stored credential as broken', () => {
    const result = classifyConnections([{ status: 'active', count: 2, missing_credential: 1 }]);
    expect(result.level).toBe('error');
    expect(result.sentence).toContain('1 active without a stored credential');
  });

  it('flags a linking-only account without calling it broken', () => {
    expect(classifyConnections([{ status: 'linking', count: 1, missing_credential: 0 }]).level).toBe('attention');
  });

  it('reports an empty control plane as attention, not as health', () => {
    const result = classifyConnections([]);
    expect(result.level).toBe('attention');
    expect(result.sentence).toContain('No Cloudflare account is connected');
  });
});

describe('workspace runtime rows', () => {
  const context = { now: NOW, desiredRuntimeVersion: CURRENT_RUNTIME };

  it('passes an account on the current build', () => {
    const row = {
      email: 'a@example.com',
      status: 'ready',
      runtime_version: CURRENT_RUNTIME,
      updated_at: NOW - 3 * HOUR,
    };
    expect(describeWorkspaceRuntime(row, context)).toMatchObject({
      level: 'ok',
      sentence: 'a@example.com is on the current workspace runtime (updated 3h ago).',
    });
  });

  it('flags a stale runtime with both short hashes', () => {
    const row = { email: 'a@example.com', status: 'ready', runtime_version: OLD_RUNTIME, updated_at: NOW - 2 * DAY };
    const result = describeWorkspaceRuntime(row, context);
    expect(result.level).toBe('attention');
    expect(result.sentence).toBe(
      "a@example.com is on runtime bbbbbbbbbbbb, not this checkout's aaaaaaaaaaaa (updated 2d ago).",
    );
  });

  it('reports a provisioning failure with the provider reason unwrapped', () => {
    const row = {
      email: 'a@example.com',
      status: 'error',
      runtime_version: OLD_RUNTIME,
      last_error: '{"error":"Workers  subdomain\\nunavailable"}',
      updated_at: NOW - 90 * MINUTE,
    };
    const result = describeWorkspaceRuntime(row, context);
    expect(result.level).toBe('error');
    expect(result.sentence).toBe(
      'a@example.com failed to provision a workspace runtime 1h ago: Workers subdomain unavailable',
    );
  });

  it('separates provisioning in progress from a stuck lease', () => {
    const inFlight = describeWorkspaceRuntime(
      {
        email: 'a@example.com',
        status: 'provisioning',
        updated_at: NOW - 2 * MINUTE,
        provisioning_lease_expires_at: NOW + HOUR,
      },
      context,
    );
    expect(inFlight.level).toBe('attention');
    const stuck = describeWorkspaceRuntime(
      {
        email: 'a@example.com',
        status: 'provisioning',
        updated_at: NOW - DAY,
        provisioning_lease_expires_at: NOW - HOUR,
      },
      context,
    );
    expect(stuck.level).toBe('error');
    expect(stuck.sentence).toBe('a@example.com is stuck provisioning: the lease expired 1h ago.');
  });

  it('flags a connected account that has no runtime row at all', () => {
    const result = describeWorkspaceRuntime({ email: 'a@example.com', status: null }, context);
    expect(result.level).toBe('attention');
    expect(result.sentence).toBe('a@example.com has an active connection but no workspace runtime yet.');
  });

  it('refuses to judge staleness with no local build to compare against', () => {
    const result = describeWorkspaceRuntime(
      { email: 'a@example.com', status: 'ready', runtime_version: OLD_RUNTIME, updated_at: NOW },
      { now: NOW, desiredRuntimeVersion: null },
    );
    expect(result.level).toBe('unknown');
    expect(result.sentence).toContain('no local build to compare it against');
  });
});

describe('skill sync rows', () => {
  it('renders each recorded outcome', () => {
    expect(
      describeSkillSyncRun(
        { status: 'published', completed_at: NOW - HOUR, generation: 'abcdef0123456789', file_count: 42 },
        NOW,
      ),
    ).toMatchObject({
      level: 'ok',
      sentence: 'Builder skills published generation abcdef012345 with 42 files 1h ago.',
    });
    expect(
      describeSkillSyncRun(
        { status: 'unchanged', completed_at: NOW - 30 * MINUTE, generation: 'abcdef0123456789' },
        NOW,
      ),
    ).toMatchObject({ level: 'ok' });
    expect(describeSkillSyncRun({ status: 'busy', completed_at: NOW - HOUR }, NOW).level).toBe('attention');
    expect(
      describeSkillSyncRun({ status: 'error', completed_at: NOW - HOUR, error: 'rate limited' }, NOW),
    ).toMatchObject({ level: 'error', sentence: 'The builder skill sync failed 1h ago: rate limited.' });
  });

  it('escalates a run that has claimed to be running for too long', () => {
    expect(describeSkillSyncRun({ status: 'running', started_at: NOW - 5 * MINUTE }, NOW).level).toBe('attention');
    const wedged = describeSkillSyncRun({ status: 'running', started_at: NOW - 6 * HOUR }, NOW);
    expect(wedged.level).toBe('error');
    expect(wedged.sentence).toContain('has been running since 6h ago');
  });

  it('names a missing generation rather than printing an empty hash', () => {
    expect(describeSkillSyncRun({ status: 'published', completed_at: NOW, generation: null }, NOW).sentence).toContain(
      'generation unknown',
    );
  });
});

describe('daily maintenance slots', () => {
  it('passes a job that claimed a slot within the day', () => {
    const entries = describeDailyJobs(
      [
        { job: 'builder-skill-sync', last_started_at: NOW - 20 * HOUR },
        { job: 'app-resource-reconcile', last_started_at: NOW - 20 * HOUR },
      ],
      NOW,
    );
    expect(entries.map((entry) => entry.level)).toEqual(['ok', 'ok']);
    expect(entries[0].sentence).toBe('app-resource-reconcile last started 20h ago.');
  });

  it('flags a job whose slot is older than the daily interval', () => {
    const entries = describeDailyJobs(
      [
        { job: 'builder-skill-sync', last_started_at: NOW - 3 * DAY },
        { job: 'app-resource-reconcile', last_started_at: NOW - 20 * HOUR },
      ],
      NOW,
    );
    const late = entries.find((entry) => entry.job === 'builder-skill-sync');
    expect(late?.level).toBe('attention');
    expect(late?.sentence).toBe('builder-skill-sync last started 3d ago, so the daily cron is not reaching it.');
  });

  it('reports an expected job that has no row at all as never having run', () => {
    const entries = describeDailyJobs([{ job: 'app-resource-reconcile', last_started_at: NOW - HOUR }], NOW);
    const missing = entries.find((entry) => entry.job === 'builder-skill-sync');
    expect(missing).toMatchObject({
      level: 'attention',
      at: null,
      sentence: 'builder-skill-sync has never claimed a maintenance slot.',
    });
  });

  it('keeps a job the schedule gained that this tool does not know about', () => {
    const entries = describeDailyJobs(
      [
        { job: 'builder-skill-sync', last_started_at: NOW - HOUR },
        { job: 'app-resource-reconcile', last_started_at: NOW - HOUR },
        { job: 'something-new', last_started_at: NOW - HOUR },
      ],
      NOW,
    );
    expect(entries.map((entry) => entry.job)).toContain('something-new');
  });
});

describe('reconciliation sweep rows', () => {
  const clean = {
    id: 'sweep-1',
    status: 'ok',
    mode: 'report',
    started_at: NOW - 9 * HOUR - MINUTE,
    completed_at: NOW - 9 * HOUR,
    users_scanned: 2,
    users_failed: 0,
    resources_scanned: 37,
    orphans_found: 0,
    orphans_json: '[]',
    deleted_count: 0,
    listing_skipped: 0,
    error: null,
  };

  it('states that a clean sweep was report-only', () => {
    const result = describeReconcileRun(clean, NOW);
    expect(result.level).toBe('ok');
    expect(result.sentence).toBe(
      'The app resource sweep found no orphans 9h ago, running in report-only mode, deleting nothing. It scanned 37 resources across 2 accounts.',
    );
  });

  it('counts orphans from orphans_found, not from the truncated sample', () => {
    const result = describeReconcileRun(
      {
        ...clean,
        orphans_found: 250,
        orphans_json: JSON.stringify([
          { userId: 'u1', kind: 'd1', name: 'ghostbuild-abc' },
          { userId: 'u1', kind: 'r2', name: 'ghostbuild-abc-assets' },
        ]),
      },
      NOW,
    );
    expect(result.level).toBe('attention');
    expect(result.orphanCount).toBe(250);
    expect(result.sentence).toContain('nominated 250 orphaned resources');
    expect(result.sentence).toContain('(d1:ghostbuild-abc, r2:ghostbuild-abc-assets, …)');
  });

  it('says an incomplete listing makes the orphan count untrustworthy', () => {
    const result = describeReconcileRun({ ...clean, listing_skipped: 1 }, NOW);
    expect(result.level).toBe('attention');
    expect(result.skippedListing).toBe(true);
    expect(result.sentence).toContain('at least one resource listing could not be read');
    expect(result.sentence).toContain('under-reports what is there');
    expect(result.sentence).not.toContain('found no orphans');
  });

  it('flags accounts the sweep could not read even when it found nothing', () => {
    const result = describeReconcileRun({ ...clean, users_failed: 1 }, NOW);
    expect(result.level).toBe('attention');
    expect(result.sentence).toContain('and could not read 1');
  });

  it('treats enforce mode as something to notice and names what it deleted', () => {
    const result = describeReconcileRun({ ...clean, mode: 'enforce', deleted_count: 3 }, NOW);
    expect(result.level).toBe('attention');
    expect(result.sentence).toContain('ENFORCE mode, deleting 3 resources');
  });

  it('treats a stale running row as a crashed sweep rather than an in-flight one', () => {
    const inFlight = describeReconcileRun(
      { ...clean, status: 'running', completed_at: null, started_at: NOW - 5 * MINUTE },
      NOW,
    );
    expect(inFlight.level).toBe('attention');
    const crashed = describeReconcileRun(
      { ...clean, status: 'running', completed_at: null, started_at: NOW - 2 * DAY },
      NOW,
    );
    expect(crashed.level).toBe('error');
    expect(crashed.sentence).toBe(
      'An app resource sweep started 2d ago and has not finished, long past the point where one should have.',
    );
  });

  it('surfaces a recorded sweep error', () => {
    const result = describeReconcileRun({ ...clean, status: 'error', error: 'listing failed' }, NOW);
    expect(result.level).toBe('error');
    expect(result.sentence).toContain('listing failed');
  });

  it('reads a renamed timestamp column rather than reporting a healthy zero', () => {
    const { completed_at: _completed, ...withoutCompletedAt } = clean;
    const result = describeReconcileRun({ ...withoutCompletedAt, finished_at: NOW - 2 * HOUR }, NOW);
    expect(result.at).toBe(NOW - 2 * HOUR);
  });
});

describe('wrangler output handling', () => {
  it('keeps only the rows from each statement envelope', () => {
    const stdout = '\n[{"results":[{"total":2}],"success":true},{"results":[],"success":true}]';
    expect(parseD1Response(stdout)).toEqual([[{ total: 2 }], []]);
  });

  it('rejects output that is not a D1 result array', () => {
    expect(() => parseD1Response('not json at all')).toThrow('did not return a D1 result array');
  });

  it('reduces a wrangler failure to the note an operator can act on', () => {
    const stdout = JSON.stringify({
      error: {
        text: 'A request to the Cloudflare API failed.',
        notes: [{ text: 'no such table: app_resource_reconcile_runs: SQLITE_ERROR [code: 7500]' }],
      },
    });
    expect(describeWranglerFailure({ stdout, stderr: '' })).toBe(
      'no such table: app_resource_reconcile_runs: SQLITE_ERROR [code: 7500]',
    );
    expect(describeWranglerFailure({ stderr: 'You are not authenticated.' })).toBe('You are not authenticated.');
    expect(describeWranglerFailure({ message: 'spawn pnpm ENOENT' })).toBe('spawn pnpm ENOENT');
  });
});

describe('headline', () => {
  it('says so in one line when everything is fine', () => {
    const checks = [{ status: 'ok' }, { status: 'ok' }];
    expect(headlineFor(checks, { ok: true })).toBe('Everything is healthy: all 2 checks passed.');
  });

  it('counts each kind of problem', () => {
    const checks = [
      { status: 'error' },
      { status: 'attention' },
      { status: 'attention' },
      { status: 'unknown' },
      { status: 'ok' },
    ];
    expect(headlineFor(checks, { ok: true })).toBe(
      '1 check is broken, 2 checks need attention, 1 check could not be read.',
    );
  });

  it('leads with the read failure when the control plane is unreachable', () => {
    expect(headlineFor([], { ok: false, error: 'You are not authenticated.' })).toBe(
      'The control plane could not be read: You are not authenticated.',
    );
  });
});

type Row = Record<string, unknown>;
/** What the injected query resolves to: one row list per statement. */
type Rows = Row[][];
/** One statement group per table, or the failure that reading it produces. */
type Fixture = Record<string, Rows | Error>;
type Check = {
  id: string;
  title: string;
  status: string;
  sentence: string;
  at: number | null;
  relative: string | null;
  detail: Row;
};
type Report = { status: string; headline: string; controlPlaneReadable: boolean; checks: Check[] };

/** The report is assembled in JavaScript; naming the shape here is what pins it down. */
function reportOf(value: unknown): Report {
  return value as Report;
}

function checkById(report: unknown, id: string): Check {
  const found = reportOf(report).checks.find((item) => item.id === id);
  if (!found) {
    throw new Error(`The report has no "${id}" check.`);
  }
  return found;
}

/** Fixture rows shaped like the production control plane, with nothing wrong in them. */
function healthyFixture(): Fixture {
  return {
    core: [
      [{ total: 2, joined_this_week: 1, joined_last_week: 1 }],
      [{ status: 'active', count: 2, missing_credential: 0 }],
      [{ unexpired: 3 }],
      [
        {
          email: 'a@example.com',
          status: 'ready',
          runtime_version: CURRENT_RUNTIME,
          updated_at: NOW - 3 * HOUR,
        },
        {
          email: 'b@example.com',
          status: 'ready',
          runtime_version: CURRENT_RUNTIME,
          updated_at: NOW - 4 * HOUR,
        },
      ],
    ],
    builder_skill_sync_state: [
      [{ singleton: 1, expected_generation: 'gen0123456789', last_checked_at: NOW - 2 * HOUR, active_run_id: null }],
    ],
    builder_skill_sync_runs: [
      [
        {
          id: 'run-1',
          status: 'unchanged',
          started_at: NOW - 2 * HOUR,
          completed_at: NOW - 2 * HOUR,
          generation: 'gen0123456789',
        },
      ],
    ],
    app_resource_reconcile_runs: [
      [
        {
          id: 'sweep-1',
          status: 'ok',
          mode: 'report',
          started_at: NOW - 2 * HOUR,
          completed_at: NOW - 2 * HOUR,
          users_scanned: 2,
          users_failed: 0,
          resources_scanned: 37,
          orphans_found: 0,
          orphans_json: '[]',
          deleted_count: 0,
          listing_skipped: 0,
        },
      ],
    ],
    daily_maintenance_jobs: [
      [
        { job: 'builder-skill-sync', last_started_at: NOW - 2 * HOUR },
        { job: 'app-resource-reconcile', last_started_at: NOW - 2 * HOUR },
      ],
    ],
  };
}

/** Route a statement to its fixture by the table it reads. */
function fixtureQuery(fixture: Fixture) {
  return async (sql: string): Promise<Rows> => {
    const [, rows] = Object.entries(fixture).find(([table]) => table !== 'core' && sql.includes(table)) ?? [
      'core',
      fixture.core,
    ];
    if (rows instanceof Error) {
      throw rows;
    }
    return rows ?? [];
  };
}

describe('report shape', () => {
  it('reports a healthy platform in one line and exposes every check structurally', async () => {
    const report = await collectReport({
      query: fixtureQuery(healthyFixture()),
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });

    expect(report).toMatchObject({
      generatedAt: NOW,
      generatedAtIso: '2026-08-18T12:00:00.000Z',
      database: 'ghostbuild',
      controlPlaneReadable: true,
      status: 'ok',
      headline: 'Everything is healthy: all 7 checks passed.',
    });
    expect(reportOf(report).checks.map((item) => item.id)).toEqual([
      'cloudflare-accounts',
      'workspace-runtimes',
      'builder-skill-sync',
      'app-resource-sweep',
      'daily-maintenance',
      'users',
      'sessions',
    ]);
    for (const item of reportOf(report).checks) {
      expect(item).toMatchObject({
        id: expect.any(String),
        title: expect.any(String),
        status: 'ok',
        sentence: expect.any(String),
      });
      expect(item).toHaveProperty('detail');
    }
    const runtimes = checkById(report, 'workspace-runtimes');
    expect(runtimes.sentence).toBe("2 of 2 workspace runtimes are on this checkout's current build aaaaaaaaaaaa.");
    expect(runtimes.relative).toBe('3h ago');
    expect(runtimes.detail.entries).toHaveLength(2);
    expect(checkById(report, 'app-resource-sweep').detail).toMatchObject({
      mode: 'report',
      orphanCount: 0,
      skippedListing: false,
    });
    expect(checkById(report, 'daily-maintenance').sentence).toBe(
      'All 2 daily maintenance jobs fired within the last day.',
    );
  });

  it('leads with what is wrong and never reports a missing table as zero', async () => {
    const fixture = healthyFixture();
    const core = fixture.core as Rows;
    core[1] = [
      { status: 'active', count: 1, missing_credential: 0 },
      { status: 'error', count: 1, missing_credential: 0 },
    ];
    core[3][0].runtime_version = OLD_RUNTIME;
    fixture.app_resource_reconcile_runs = new Error('no such table: app_resource_reconcile_runs');

    const report = await collectReport({
      query: fixtureQuery(fixture),
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });

    expect(reportOf(report).status).toBe('error');
    expect(reportOf(report).headline).toBe('1 check is broken, 1 check needs attention, 1 check could not be read.');
    const sweep = checkById(report, 'app-resource-sweep');
    expect(sweep.status).toBe('unknown');
    expect(sweep.detail.missingTable).toBe('app_resource_reconcile_runs');
    expect(sweep.detail.orphanCount).toBeUndefined();

    const text = renderReport(report);
    expect(text.indexOf('BROKEN')).toBeLessThan(text.indexOf('NEEDS ATTENTION'));
    expect(text.indexOf('NEEDS ATTENTION')).toBeLessThan(text.indexOf('COULD NOT BE READ'));
    expect(text.indexOf('COULD NOT BE READ')).toBeLessThan(text.indexOf('HEALTHY'));
    expect(text).toContain('`app_resource_reconcile_runs` does not exist in production yet');
    expect(text).toContain("a@example.com is on runtime bbbbbbbbbbbb, not this checkout's aaaaaaaaaaaa");
  });

  it('reports every migrated table as unknown before the migration is deployed', async () => {
    const fixture = healthyFixture();
    for (const table of [
      'builder_skill_sync_state',
      'builder_skill_sync_runs',
      'app_resource_reconcile_runs',
      'daily_maintenance_jobs',
    ]) {
      fixture[table] = new Error(`no such table: ${table}: SQLITE_ERROR [code: 7500]`);
    }

    const report = await collectReport({
      query: fixtureQuery(fixture),
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });

    expect(reportOf(report).status).toBe('unknown');
    expect(reportOf(report).headline).toBe('3 checks could not be read.');
    for (const id of ['builder-skill-sync', 'app-resource-sweep', 'daily-maintenance']) {
      const item = checkById(report, id);
      expect(item.status).toBe('unknown');
      expect(item.sentence).toContain('does not exist in production yet');
    }
    // The tables that do exist are still reported, so a missing migration costs three checks.
    expect(checkById(report, 'cloudflare-accounts').status).toBe('ok');
  });

  it('marks every control-plane check unknown when wrangler cannot read the database', async () => {
    const fixture = healthyFixture();
    fixture.core = new Error('You are not authenticated.');

    const report = await collectReport({ query: fixtureQuery(fixture), now: NOW, desiredRuntimeVersion: null });

    expect(reportOf(report).controlPlaneReadable).toBe(false);
    expect(reportOf(report).status).toBe('unknown');
    expect(reportOf(report).headline).toBe('The control plane could not be read: You are not authenticated.');
    const unknownIds = reportOf(report)
      .checks.filter((item) => item.status === 'unknown')
      .map((item) => item.id);
    expect(unknownIds).toEqual(
      expect.arrayContaining(['users', 'cloudflare-accounts', 'sessions', 'workspace-runtimes']),
    );
    expect(renderReport(report)).not.toContain('Everything is healthy');
  });

  it('cannot judge runtime staleness without a local runtime build', async () => {
    const report = await collectReport({
      query: fixtureQuery(healthyFixture()),
      now: NOW,
      desiredRuntimeVersion: null,
    });
    const runtimes = checkById(report, 'workspace-runtimes');
    expect(runtimes.status).toBe('unknown');
    expect(runtimes.sentence).toContain('pnpm run generate:user-workspace-runtime');
    expect(reportOf(report).status).toBe('unknown');
  });

  it('flags a daily job that has stopped firing', async () => {
    const fixture = healthyFixture();
    fixture.daily_maintenance_jobs = [
      [
        { job: 'builder-skill-sync', last_started_at: NOW - 2 * HOUR },
        { job: 'app-resource-reconcile', last_started_at: NOW - 5 * DAY },
      ],
    ];

    const report = await collectReport({
      query: fixtureQuery(fixture),
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });
    const maintenance = checkById(report, 'daily-maintenance');
    expect(maintenance.status).toBe('attention');
    expect(maintenance.sentence).toBe('1 of 2 daily maintenance jobs did not fire as scheduled.');
    expect(renderReport(report)).toContain('app-resource-reconcile last started 5d ago');
  });

  it('reports a job that claimed its slot but recorded no run as started and died', async () => {
    const fixture = healthyFixture();
    fixture.daily_maintenance_jobs = [
      [
        { job: 'builder-skill-sync', last_started_at: NOW - 2 * HOUR },
        { job: 'app-resource-reconcile', last_started_at: NOW - 30 * MINUTE },
      ],
    ];

    const report = await collectReport({
      query: fixtureQuery(fixture),
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });
    const maintenance = checkById(report, 'daily-maintenance');
    expect(maintenance.status).toBe('error');
    expect(renderReport(report)).toContain(
      'app-resource-reconcile claimed its slot 30m ago but recorded no run, so it started and died.',
    );
  });

  it('treats a job that has never run as attention rather than as health', async () => {
    const fixture = healthyFixture();
    fixture.builder_skill_sync_runs = [[]];
    fixture.app_resource_reconcile_runs = [[]];
    fixture.daily_maintenance_jobs = [[]];

    const report = await collectReport({
      query: fixtureQuery(fixture),
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });
    expect(reportOf(report).status).toBe('attention');
    expect(checkById(report, 'builder-skill-sync').sentence).toBe('No builder skill sync has ever run.');
    expect(checkById(report, 'app-resource-sweep').sentence).toBe(
      'No app resource reconciliation sweep has been recorded yet.',
    );
    expect(renderReport(report)).toContain('builder-skill-sync has never claimed a maintenance slot.');
  });
});
