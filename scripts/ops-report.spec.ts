import { describe, expect, it } from 'vitest';
import {
  classifyConnections,
  collectReport,
  describeReconcileRun,
  describeDailyJobs,
  describeWorkerInvocations,
  describeWorkspaceRuntime,
  describeWranglerFailure,
  formatDuration,
  formatRelativeTime,
  headlineFor,
  parseD1Response,
  readInvocationGroups,
  readWorkerInvocations,
  renderReport,
  WORKER_INVOCATIONS_QUERY,
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

describe('daily maintenance slots', () => {
  it('passes a job that claimed a slot within the day', () => {
    const entries = describeDailyJobs(
      [
        { job: 'app-resource-reconcile', last_started_at: NOW - 20 * HOUR },
        { job: 'workspace-runtime-reclaim', last_started_at: NOW - 20 * HOUR },
      ],
      NOW,
    );
    expect(entries.map((entry) => entry.level)).toEqual(['ok', 'ok']);
    expect(entries[0].sentence).toBe('app-resource-reconcile last started 20h ago.');
  });

  it('flags a job whose slot is older than the daily interval', () => {
    const entries = describeDailyJobs([{ job: 'app-resource-reconcile', last_started_at: NOW - 3 * DAY }], NOW);
    const late = entries.find((entry) => entry.job === 'app-resource-reconcile');
    expect(late?.level).toBe('attention');
    expect(late?.sentence).toBe('app-resource-reconcile last started 3d ago, so the daily cron is not reaching it.');
  });

  it('reports an expected job that has no row at all as never having run', () => {
    const entries = describeDailyJobs([], NOW);
    const missing = entries.find((entry) => entry.job === 'app-resource-reconcile');
    expect(missing).toMatchObject({
      level: 'attention',
      at: null,
      sentence: 'app-resource-reconcile has never claimed a maintenance slot.',
    });
  });

  it('keeps a job the schedule gained that this tool does not know about', () => {
    const entries = describeDailyJobs(
      [
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
    skipped_listings_json: null,
    error: null,
  };

  /** The clean row with one column dropped, as a result set with drifted schema would arrive. */
  function rowWithout(column: string): Record<string, unknown> {
    const row: Record<string, unknown> = { ...clean };
    delete row[column];
    return row;
  }

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
    expect(result.sentence).toContain('could not read at least one resource listing');
    expect(result.sentence).toContain('under-reports what is there');
    expect(result.sentence).not.toContain('found no orphans');
  });

  it('names the listings it could not read, because a skip is only actionable when named', () => {
    const result = describeReconcileRun(
      { ...clean, listing_skipped: 1, skipped_listings_json: JSON.stringify(['KV namespace', 'R2 bucket']) },
      NOW,
    );
    expect(result.level).toBe('attention');
    expect(result.sentence).toContain('could not read KV namespace, R2 bucket');
    expect(result.sentence).not.toContain('at least one resource listing');
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

  it('reads a run that is still going, whose completion time is legitimately absent', () => {
    const result = describeReconcileRun({ ...clean, status: 'running', completed_at: null }, NOW);
    expect(result.at).toBe(clean.started_at);
  });

  it('refuses to read a row that is missing a column the schema declares', () => {
    // Each of these used to be substituted with a value that reads as good news.
    for (const column of [
      'status',
      'mode',
      'started_at',
      'completed_at',
      'users_scanned',
      'users_failed',
      'resources_scanned',
      'orphans_found',
      'deleted_count',
      'listing_skipped',
      'orphans_json',
      'skipped_listings_json',
      'error',
    ]) {
      expect(() => describeReconcileRun(rowWithout(column), NOW)).toThrow(
        `app_resource_reconcile_runs rows have no \`${column}\` column`,
      );
    }
  });

  it('never reads a missing status as a healthy run', () => {
    expect(() => describeReconcileRun(rowWithout('status'), NOW)).toThrow(/`status` column/);
    expect(() => describeReconcileRun({ ...clean, status: 'finished' }, NOW)).toThrow(
      'app_resource_reconcile_runs.status holds the string "finished", not one of running, ok, error.',
    );
  });

  it('never reads a missing orphan count as the length of the truncated sample', () => {
    expect(() =>
      describeReconcileRun(
        { ...rowWithout('orphans_found'), orphans_json: JSON.stringify([{ userId: 'u1', kind: 'd1', name: 'a' }]) },
        NOW,
      ),
    ).toThrow(/`orphans_found` column/);
    expect(() => describeReconcileRun({ ...clean, orphans_found: null }, NOW)).toThrow(
      'app_resource_reconcile_runs.orphans_found holds null, not a number.',
    );
  });

  it('never reads an unrecognisable skip flag as a complete listing', () => {
    expect(() => describeReconcileRun({ ...clean, listing_skipped: 'yes' }, NOW)).toThrow(
      'app_resource_reconcile_runs.listing_skipped holds the string "yes", not 0 or 1.',
    );
    expect(() => describeReconcileRun({ ...clean, listing_skipped: null }, NOW)).toThrow(/not 0 or 1/);
  });

  it('never reads unparseable JSON as an empty list', () => {
    expect(() => describeReconcileRun({ ...clean, orphans_json: '[{"kind":' }, NOW)).toThrow(
      /app_resource_reconcile_runs\.orphans_json is not valid JSON/,
    );
    expect(() => describeReconcileRun({ ...clean, orphans_json: '{"kind":"d1"}' }, NOW)).toThrow(/not a JSON array/);
    expect(() =>
      describeReconcileRun({ ...clean, listing_skipped: 1, skipped_listings_json: 'KV namespace' }, NOW),
    ).toThrow(/skipped_listings_json is not valid JSON/);
  });

  it('carries the named listings into the structured detail, not only into the sentence', () => {
    const result = describeReconcileRun(
      { ...clean, listing_skipped: 1, skipped_listings_json: JSON.stringify(['KV namespace']) },
      NOW,
    );
    expect(result.skippedListings).toEqual(['KV namespace']);
  });
});

describe('control-plane Worker invocations', () => {
  const group = (status: string, requests: number, sampleInterval = 1) => ({
    dimensions: { status },
    sum: { requests, errors: 0 },
    avg: { sampleInterval },
  });

  it('reports a Worker that served without failing', () => {
    const result = describeWorkerInvocations([group('success', 640)]);
    expect(result.level).toBe('ok');
    expect(result.sentence).toBe(
      'ghostbuild served 640 invocations in the last 24h and none of them failed inside the Worker.',
    );
    expect(result.detail).toMatchObject({ invocations: 640, faulted: 0, logsAvailable: false });
  });

  it('treats a window with no invocations as attention, never as a healthy zero', () => {
    const result = describeWorkerInvocations([]);
    expect(result.level).toBe('attention');
    expect(result.sentence).toContain('recorded no invocations at all in the last 24h');
    expect(result.detail).toMatchObject({ invocations: 0 });
  });

  it('escalates by how much of the traffic failed, and names what it cannot tell', () => {
    const rare = describeWorkerInvocations([group('success', 1000), group('scriptThrew', 5)]);
    expect(rare.level).toBe('attention');
    expect(rare.sentence).toContain(
      'failed inside the Worker on 5 of 1005 invocations in the last 24h (scriptThrew 5)',
    );
    // The counts are not the exception text, and the report says which one it is offering.
    expect(rare.sentence).toContain('Workers Logs holds the exception text');

    const outage = describeWorkerInvocations([
      group('success', 900),
      group('scriptThrew', 60),
      group('exceededCpu', 40),
    ]);
    expect(outage.level).toBe('error');
    expect(outage.sentence).toContain('on 100 of 1000 invocations');
    // Worst first, so the dominant failure leads.
    expect(outage.sentence).toContain('(scriptThrew 60, exceededCpu 40)');
  });

  it('counts an outcome it has never seen as a fault rather than dropping it', () => {
    const result = describeWorkerInvocations([group('success', 10), group('exceededSomethingNew', 10)]);
    expect(result.level).toBe('error');
    expect(result.sentence).toContain('exceededSomethingNew 10');
    expect(result.detail.faulted).toBe(10);
  });

  it('does not blame the Worker for callers that went away', () => {
    const result = describeWorkerInvocations([group('success', 90), group('clientDisconnected', 10)]);
    expect(result.level).toBe('ok');
    expect(result.detail).toMatchObject({ invocations: 100, faulted: 0, byStatus: { clientDisconnected: 10 } });
  });

  it('says when the counts are extrapolated from a sample', () => {
    expect(describeWorkerInvocations([group('success', 640, 4)]).sentence).toContain(
      'Counts are extrapolated from roughly 1 invocation in 4.0.',
    );
    expect(describeWorkerInvocations([group('success', 640, 1)]).sentence).not.toContain('extrapolated');
  });

  it('refuses to read a group whose shape is not the one it expects', () => {
    expect(() => describeWorkerInvocations([{ sum: { requests: 1 } }])).toThrow('`dimensions.status`');
    expect(() => describeWorkerInvocations([{ dimensions: { status: 'success' }, sum: {} }])).toThrow(
      'workersInvocationsAdaptive.sum.requests holds the undefined undefined, not a number.',
    );
  });
});

describe('workers analytics envelope', () => {
  const envelope = (groups: unknown) => ({
    data: { viewer: { accounts: [{ workersInvocationsAdaptive: groups }] } },
  });

  it('keeps the groups out of a successful answer', () => {
    expect(readInvocationGroups(envelope([{ dimensions: { status: 'success' } }]), 200)).toEqual([
      { dimensions: { status: 'success' } },
    ]);
  });

  it('never renders a refused read as an empty window', () => {
    // GraphQL answers a refusal with HTTP 200, so only the envelope tells these apart.
    expect(() =>
      readInvocationGroups({ data: null, errors: [{ message: 'not authorized for that account' }] }, 200),
    ).toThrow('Cloudflare analytics refused the read: not authorized for that account');
    expect(() => readInvocationGroups({ data: { viewer: { accounts: [] } } }, 200)).toThrow(
      'no `workersInvocationsAdaptive` result',
    );
    expect(() => readInvocationGroups(null, 502)).toThrow('answered HTTP 502 with no readable body');
  });
});

describe('reading the Worker as the operator', () => {
  type Run = (file: string, args: string[]) => Promise<{ stdout: string }>;

  /** Account resolution reads the environment first, so every test states what is in it. */
  const noEnv: Record<string, string | undefined> = {};

  function wranglerFake(overrides: { accounts?: unknown[]; credential?: unknown } = {}): Run {
    return async (_file, args) => {
      if (args.includes('whoami')) {
        return { stdout: JSON.stringify({ accounts: overrides.accounts ?? [{ id: 'acct-1', name: 'One' }] }) };
      }
      return { stdout: JSON.stringify(overrides.credential ?? { type: 'oauth', token: 'oauth-token' }) };
    };
  }

  function fetchFake(payload: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    };
    return { impl: impl as unknown as typeof fetch, calls };
  }

  const groups = [{ dimensions: { status: 'success' }, sum: { requests: 1, errors: 0 }, avg: { sampleInterval: 1 } }];
  const answer = { data: { viewer: { accounts: [{ workersInvocationsAdaptive: groups }] } } };

  it('asks for one day of the named script with the operator credential', async () => {
    const fetcher = fetchFake(answer);
    const rows = await readWorkerInvocations({
      now: NOW,
      run: wranglerFake() as never,
      fetchImpl: fetcher.impl,
      env: noEnv,
    });

    expect(rows).toEqual(groups);
    expect(fetcher.calls).toHaveLength(1);
    const [{ url, init }] = fetcher.calls;
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer oauth-token');
    const body = JSON.parse(String(init.body));
    expect(body.query).toBe(WORKER_INVOCATIONS_QUERY);
    expect(body.variables).toEqual({
      account: 'acct-1',
      script: 'ghostbuild',
      from: new Date(NOW - DAY).toISOString(),
      to: new Date(NOW).toISOString(),
    });
  });

  it('authenticates a global API key with the headers that key needs', async () => {
    const fetcher = fetchFake(answer);
    await readWorkerInvocations({
      now: NOW,
      run: wranglerFake({ credential: { type: 'api_key', key: 'k', email: 'ops@example.com' } }) as never,
      fetchImpl: fetcher.impl,
      env: noEnv,
    });
    expect(fetcher.calls[0].init.headers).toMatchObject({ 'x-auth-key': 'k', 'x-auth-email': 'ops@example.com' });
  });

  it('asks which account rather than guessing when wrangler holds several', async () => {
    await expect(
      readWorkerInvocations({
        now: NOW,
        run: wranglerFake({
          accounts: [
            { id: 'a', name: 'One' },
            { id: 'b', name: 'Two' },
          ],
        }) as never,
        fetchImpl: fetchFake(answer).impl,
        env: noEnv,
      }),
    ).rejects.toThrow('authenticated against 2 accounts (One, Two); set CLOUDFLARE_ACCOUNT_ID');
  });

  it('follows CLOUDFLARE_ACCOUNT_ID the way wrangler does', async () => {
    const fetcher = fetchFake(answer);
    await readWorkerInvocations({
      now: NOW,
      run: wranglerFake({ accounts: [{ id: 'a' }, { id: 'b' }] }) as never,
      fetchImpl: fetcher.impl,
      env: { CLOUDFLARE_ACCOUNT_ID: 'from-the-environment' },
    });
    expect(JSON.parse(String(fetcher.calls[0].init.body)).variables.account).toBe('from-the-environment');
  });

  it('never quotes the credential command output back into an error', async () => {
    const run = (async (_file: string, args: string[]) => {
      if (args.includes('whoami')) {
        return { stdout: JSON.stringify({ accounts: [{ id: 'acct-1' }] }) };
      }
      // `wrangler auth token` prints the credential itself on stdout.
      throw Object.assign(new Error('Command failed'), {
        stdout: 'super-secret-token',
        stderr: 'Not logged in. Please run `wrangler login`.',
      });
    }) as never;

    await expect(
      readWorkerInvocations({ now: NOW, run, fetchImpl: fetchFake(answer).impl, env: noEnv }),
    ).rejects.toThrow(
      'Wrangler could not produce a credential for the Worker read: Not logged in. Please run `wrangler login`.',
    );
    await expect(
      readWorkerInvocations({ now: NOW, run, fetchImpl: fetchFake(answer).impl, env: noEnv }),
    ).rejects.not.toThrow(/super-secret-token/);
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
          skipped_listings_json: null,
          error: null,
        },
      ],
    ],
    daily_maintenance_jobs: [
      [
        { job: 'app-resource-reconcile', last_started_at: NOW - 2 * HOUR },
        { job: 'workspace-runtime-reclaim', last_started_at: NOW - 2 * HOUR },
      ],
    ],
  };
}

/** Invocation groups shaped like the Workers analytics answer, with nothing wrong in them. */
function healthyInvocationGroups(): Row[] {
  return [{ dimensions: { status: 'success' }, sum: { requests: 640, errors: 0 }, avg: { sampleInterval: 1 } }];
}

const healthyInvocations = async () => healthyInvocationGroups();

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
      readInvocations: healthyInvocations,
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
      'control-plane-worker',
      'cloudflare-accounts',
      'workspace-runtimes',
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
      readInvocations: healthyInvocations,
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
    for (const table of ['app_resource_reconcile_runs', 'daily_maintenance_jobs']) {
      fixture[table] = new Error(`no such table: ${table}: SQLITE_ERROR [code: 7500]`);
    }

    const report = await collectReport({
      query: fixtureQuery(fixture),
      readInvocations: healthyInvocations,
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });

    expect(reportOf(report).status).toBe('unknown');
    expect(reportOf(report).headline).toBe('2 checks could not be read.');
    for (const id of ['app-resource-sweep', 'daily-maintenance']) {
      const item = checkById(report, id);
      expect(item.status).toBe('unknown');
      expect(item.sentence).toContain('does not exist in production yet');
    }
    // The tables that do exist are still reported, so a missing migration costs two checks.
    expect(checkById(report, 'cloudflare-accounts').status).toBe('ok');
  });

  it('marks every control-plane check unknown when wrangler cannot read the database', async () => {
    const fixture = healthyFixture();
    fixture.core = new Error('You are not authenticated.');

    const report = await collectReport({
      query: fixtureQuery(fixture),
      readInvocations: healthyInvocations,
      now: NOW,
      desiredRuntimeVersion: null,
    });

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
      readInvocations: healthyInvocations,
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
        { job: 'app-resource-reconcile', last_started_at: NOW - 5 * DAY },
        { job: 'workspace-runtime-reclaim', last_started_at: NOW - 2 * HOUR },
      ],
    ];

    const report = await collectReport({
      query: fixtureQuery(fixture),
      readInvocations: healthyInvocations,
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
        { job: 'app-resource-reconcile', last_started_at: NOW - 30 * MINUTE },
        { job: 'workspace-runtime-reclaim', last_started_at: NOW - 2 * HOUR },
      ],
    ];

    const report = await collectReport({
      query: fixtureQuery(fixture),
      readInvocations: healthyInvocations,
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });
    const maintenance = checkById(report, 'daily-maintenance');
    expect(maintenance.status).toBe('error');
    expect(renderReport(report)).toContain(
      'app-resource-reconcile claimed its slot 30m ago but recorded no run, so it started and died.',
    );
  });

  it('reports a row it cannot read as unknown, never as a healthy sweep', async () => {
    // Each of these is a row the previous reader turned into good news: no status meant "ok",
    // no count meant "no orphans", an unreadable flag meant "the listing was complete".
    const broken: Record<string, Row> = {
      'a missing status': { status: undefined },
      'a missing orphan count': { orphans_found: undefined },
      'an unparseable orphan sample': { orphans_json: '[{"kind":' },
      'an unreadable skip flag': { listing_skipped: 'maybe' },
      'a mode outside the schema': { mode: 'delete-everything' },
    };

    for (const [what, overrides] of Object.entries(broken)) {
      const fixture = healthyFixture();
      const row = { ...(fixture.app_resource_reconcile_runs as Rows)[0][0], ...overrides };
      for (const [column, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete row[column];
        }
      }
      fixture.app_resource_reconcile_runs = [[row]];

      const report = await collectReport({
        query: fixtureQuery(fixture),
        readInvocations: healthyInvocations,
        now: NOW,
        desiredRuntimeVersion: CURRENT_RUNTIME,
      });
      const sweep = checkById(report, 'app-resource-sweep');
      expect(sweep.status, what).toBe('unknown');
      expect(sweep.detail.schemaMismatch, what).toBe(true);
      // A parse failure is not a missing table, and must not be reported as one.
      expect(sweep.detail.missingTable, what).toBeNull();
      expect(sweep.sentence, what).toContain('app_resource_reconcile_runs');
      expect(sweep.sentence, what).not.toContain('does not exist in production yet');
      expect(sweep.detail.orphanCount, what).toBeUndefined();
      expect(reportOf(report).headline, what).toContain('could not be read');
      expect(renderReport(report), what).not.toContain('found no orphans');
    }
  });

  it('reports an unreadable maintenance row as unknown rather than as a failed run', async () => {
    const fixture = healthyFixture();
    fixture.daily_maintenance_jobs = [
      [
        { job: 'app-resource-reconcile', last_started_at: null },
        { job: 'workspace-runtime-reclaim', last_started_at: NOW - 2 * HOUR },
      ],
    ];

    const report = await collectReport({
      query: fixtureQuery(fixture),
      readInvocations: healthyInvocations,
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });
    const maintenance = checkById(report, 'daily-maintenance');
    expect(maintenance.status).toBe('unknown');
    expect(maintenance.sentence).toContain('daily_maintenance_jobs.last_started_at holds null');
  });

  it('reports a Worker it could not read as unknown while the control plane stays readable', async () => {
    const report = await collectReport({
      query: fixtureQuery(healthyFixture()),
      readInvocations: () => Promise.reject(new Error('Cloudflare analytics refused the read: authz')),
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });

    const worker = checkById(report, 'control-plane-worker');
    expect(worker.status).toBe('unknown');
    expect(worker.sentence).toContain('Cloudflare analytics refused the read: authz');
    expect(worker.detail.hint).toContain('Workers analytics GraphQL API');
    // The analytics read is not the control plane, so it must not change the exit status.
    expect(reportOf(report).controlPlaneReadable).toBe(true);
    expect(reportOf(report).headline).toBe('1 check could not be read.');
    expect(renderReport(report)).not.toContain('Everything is healthy');
  });

  it('reports the Worker as unknown rather than omitting it when no reader is supplied', async () => {
    const report = await collectReport({
      query: fixtureQuery(healthyFixture()),
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });
    expect(checkById(report, 'control-plane-worker').status).toBe('unknown');
  });

  it('treats a job that has never run as attention rather than as health', async () => {
    const fixture = healthyFixture();
    fixture.app_resource_reconcile_runs = [[]];
    fixture.daily_maintenance_jobs = [[]];

    const report = await collectReport({
      query: fixtureQuery(fixture),
      readInvocations: healthyInvocations,
      now: NOW,
      desiredRuntimeVersion: CURRENT_RUNTIME,
    });
    expect(reportOf(report).status).toBe('attention');
    expect(checkById(report, 'app-resource-sweep').sentence).toBe(
      'No app resource reconciliation sweep has been recorded yet.',
    );
    expect(renderReport(report)).toContain('app-resource-reconcile has never claimed a maintenance slot.');
  });
});
