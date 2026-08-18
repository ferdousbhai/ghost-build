/**
 * Read-only operational report for the Ghostbuild platform.
 *
 * This replaces the deployed `admin.ghostbuild.dev` dashboard. It reads the production
 * control-plane D1 database through the operator's own Wrangler authentication, so there is
 * nothing to deploy and no secret to hold. Every statement it issues is a `SELECT`.
 *
 * The primary reader is a coding agent, so the report leads with what is wrong, says which
 * parts it could not read instead of printing a reassuring zero, and offers `--json`.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DATABASE_NAME = 'ghostbuild';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_BUNDLE_PATH = resolve(ROOT, 'app/generated/user-workspace-runtime.generated.ts');
const RUNTIME_SHA_PATTERN = /USER_WORKSPACE_RUNTIME_SHA256 = "([a-f0-9]{64})"/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** A scheduled job that has not reported for this long has stopped, whatever its last run said. */
const SCHEDULED_JOB_STALE_MS = 2 * DAY;
/** `daily-maintenance.ts` claims a slot every 23h, so a job unseen for longer than this is late. */
const DAILY_JOB_LATE_MS = 26 * HOUR;
/** A sync that claims to still be running after this long is wedged, not busy. */
const SYNC_RUN_STUCK_MS = 30 * MINUTE;
/** A sweep reads whole Cloudflare accounts, so it gets far longer before it counts as wedged. */
const RECONCILE_RUN_STUCK_MS = 6 * HOUR;
/** A maintenance claim this much newer than its own run receipt means the job never got started. */
const DIED_AFTER_CLAIM_MS = 15 * MINUTE;
/** How many connected accounts one report inspects. */
const RUNTIME_ROW_LIMIT = 200;
/** How many orphaned resources a sentence names before it stops listing them. */
const ORPHAN_SAMPLE_LIMIT = 8;

/**
 * The jobs `app/lib/.server/daily-maintenance.ts` claims a slot for. Restated here because
 * `daily_maintenance_jobs` only holds jobs that have run at least once: a job missing from the
 * table has never fired, which is exactly the failure worth reporting.
 */
export const EXPECTED_DAILY_JOBS = ['builder-skill-sync', 'app-resource-reconcile'];

/** Worst first. A report whose headline is "healthy" must have nothing above `ok` in it. */
const STATUS_RANK = { error: 3, attention: 2, unknown: 1, ok: 0 };

/**
 * Every check the report produces, in the order the JSON lists them. The human output
 * regroups them by status; this order only decides ties.
 * @type {ReadonlyArray<{ id: string; title: string }>}
 */
const CHECK_ORDER = [
  { id: 'cloudflare-accounts', title: 'Cloudflare accounts' },
  { id: 'workspace-runtimes', title: 'Workspace runtimes' },
  { id: 'builder-skill-sync', title: 'Builder skill sync' },
  { id: 'app-resource-sweep', title: 'App resource sweep' },
  { id: 'daily-maintenance', title: 'Daily maintenance' },
  { id: 'users', title: 'Users' },
  { id: 'sessions', title: 'Sign-in sessions' },
];

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Render a timestamp as prose relative to `now`.
 *
 * The dashboard this replaces printed "0m ago" for anything under 90 seconds and "-5m ago"
 * whenever a stored clock ran ahead of the reader's. Both cases are named here instead:
 * sub-minute is "just now", a small lead is treated as clock skew, and a large lead is
 * reported as the future value it is.
 *
 * @param {unknown} value epoch milliseconds, or anything else
 * @param {number} now epoch milliseconds
 * @param {{ missing?: string | null }} [options] what to say when there is no usable timestamp
 * @returns {string | null}
 */
export function formatRelativeTime(value, now, options = {}) {
  // `?? 'never'` would swallow a caller that deliberately wants `null` for "no timestamp".
  const missing = 'missing' in options ? options.missing : 'never';
  if (!Number.isFinite(value) || !Number.isFinite(now) || value <= 0) {
    return missing;
  }
  const elapsed = now - value;
  if (elapsed >= 0) {
    return elapsed < MINUTE ? 'just now' : `${formatDuration(elapsed)} ago`;
  }
  // A stored clock a little ahead of this one is skew, not a scheduled future event.
  const ahead = -elapsed;
  return ahead < MINUTE ? 'just now' : `${formatDuration(ahead)} from now`;
}

/**
 * A non-negative span as a single coarse unit. Deliberately stops at days: "1mo" and "1m"
 * are one glance apart, and no operational answer here needs months.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'an unknown span';
  }
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(ms / HOUR);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(ms / DAY)}d`;
}

/** Age in milliseconds, or `null` when there is no usable timestamp. */
function ageOf(value, now) {
  return Number.isFinite(value) && value > 0 ? Math.max(0, now - value) : null;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/** Collapse whitespace and bound a provider string before it reaches a terminal. */
export function bounded(value, limit = 240) {
  return String(value).replaceAll(/\s+/g, ' ').trim().slice(0, limit);
}

/** Unwrap the `{"error":"..."}` envelope providers wrap their failures in. */
export function cleanErrorText(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const text = String(value);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
      return bounded(parsed.error);
    }
  } catch {
    // Not JSON. The plain text is the message.
  }
  return bounded(text);
}

/** A generation or content hash is unreadable in full and unambiguous at twelve characters. */
export function shortHash(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 12) : 'unknown';
}

function number(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

/**
 * First present column from a list of candidates.
 *
 * The reconciliation table is authored by another change in flight, so its exact column
 * names are not settled. Reading by candidate rather than by one hard-coded name lets this
 * report survive a rename instead of reporting a healthy zero.
 */
export function pickColumn(row, names) {
  for (const name of names) {
    const value = row?.[name];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return null;
}

/** A column that may hold a JSON array, a count, or nothing. */
function asList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** A column that may hold a boolean, an integer flag, or a JSON array of skipped listings. */
function asFlag(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (Number.isFinite(value)) {
    return Number(value) > 0;
  }
  if (typeof value === 'string') {
    const list = asList(value);
    if (list.length > 0) {
      return true;
    }
    return value === 'true' || value === '1';
  }
  return false;
}

// ---------------------------------------------------------------------------
// Row-to-sentence rendering
// ---------------------------------------------------------------------------

/**
 * One connected account's workspace runtime, as a status and a sentence.
 *
 * @param {Record<string, unknown>} row
 * @param {{ now: number; desiredRuntimeVersion: string | null }} context
 */
export function describeWorkspaceRuntime(row, { now, desiredRuntimeVersion }) {
  const who = typeof row.email === 'string' && row.email ? row.email : 'an unidentified account';
  const at = Number.isFinite(row.updated_at) ? Number(row.updated_at) : null;
  const when = formatRelativeTime(at, now, { missing: 'at an unrecorded time' });
  const version = typeof row.runtime_version === 'string' ? row.runtime_version : null;
  const reason = cleanErrorText(row.last_error);
  const leaseExpiry = Number.isFinite(row.provisioning_lease_expires_at)
    ? Number(row.provisioning_lease_expires_at)
    : null;
  const base = { email: who, status: row.status ?? null, runtimeVersion: version, at };

  if (!row.status) {
    return { ...base, level: 'attention', sentence: `${who} has an active connection but no workspace runtime yet.` };
  }
  if (row.status === 'error') {
    return {
      ...base,
      level: 'error',
      sentence: `${who} failed to provision a workspace runtime ${when}${reason ? `: ${reason}` : '.'}`,
    };
  }
  if (row.status === 'provisioning') {
    const expired = leaseExpiry !== null && leaseExpiry < now;
    return {
      ...base,
      level: expired ? 'error' : 'attention',
      sentence: expired
        ? `${who} is stuck provisioning: the lease expired ${formatRelativeTime(leaseExpiry, now)}.`
        : `${who} has been provisioning a workspace runtime since ${when}.`,
    };
  }
  if (desiredRuntimeVersion === null) {
    return {
      ...base,
      level: 'unknown',
      sentence: `${who} is ready on runtime ${shortHash(version)}; there is no local build to compare it against.`,
    };
  }
  if (version !== desiredRuntimeVersion) {
    return {
      ...base,
      level: 'attention',
      sentence: `${who} is on runtime ${shortHash(version)}, not this checkout's ${shortHash(desiredRuntimeVersion)} (updated ${when}).`,
    };
  }
  return { ...base, level: 'ok', sentence: `${who} is on the current workspace runtime (updated ${when}).` };
}

/**
 * The most recent builder skill sync attempt, as a status and a sentence.
 * @param {Record<string, unknown>} row
 * @param {number} now
 */
export function describeSkillSyncRun(row, now) {
  const at = Number.isFinite(row.completed_at) ? Number(row.completed_at) : Number(row.started_at);
  const when = formatRelativeTime(at, now, { missing: 'at an unrecorded time' });
  const generation = shortHash(typeof row.generation === 'string' ? row.generation : null);
  const files = number(row.file_count);
  switch (row.status) {
    case 'published':
      return {
        level: 'ok',
        at,
        sentence: `Builder skills published generation ${generation} with ${files} ${plural(files, 'file')} ${when}.`,
      };
    case 'unchanged':
      return {
        level: 'ok',
        at,
        sentence: `Builder skills were verified unchanged at generation ${generation} ${when}.`,
      };
    case 'running': {
      const age = ageOf(Number(row.started_at), now);
      const stuck = age !== null && age > SYNC_RUN_STUCK_MS;
      return {
        level: stuck ? 'error' : 'attention',
        at: Number(row.started_at),
        sentence: stuck
          ? `A builder skill sync has been running since ${formatRelativeTime(Number(row.started_at), now)} and has not finished.`
          : `A builder skill sync started ${formatRelativeTime(Number(row.started_at), now)} and is still running.`,
      };
    }
    case 'busy':
      return {
        level: 'attention',
        at,
        sentence: `The builder skill sync deferred ${when} because another sync held the lock.`,
      };
    default:
      return {
        level: 'error',
        at,
        sentence: `The builder skill sync failed ${when}: ${cleanErrorText(row.error) ?? 'no error was recorded'}.`,
      };
  }
}

/**
 * The daily maintenance slots, as one entry per job.
 *
 * `daily_maintenance_jobs` records when each job last claimed its slot, which is the only
 * evidence that the cron is still firing at all. A job that has never claimed one has no row.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {number} now
 */
export function describeDailyJobs(rows, now) {
  const lastStarted = new Map(rows.map((row) => [String(row.job), number(row.last_started_at, 0)]));
  const names = [...new Set([...EXPECTED_DAILY_JOBS, ...lastStarted.keys()])].sort();
  return names.map((job) => {
    const at = lastStarted.get(job) ?? null;
    if (at === null || at <= 0) {
      return { job, at: null, level: 'attention', sentence: `${job} has never claimed a maintenance slot.` };
    }
    const age = ageOf(at, now);
    const late = age !== null && age > DAILY_JOB_LATE_MS;
    return {
      job,
      at,
      level: late ? 'attention' : 'ok',
      sentence: late
        ? `${job} last started ${formatRelativeTime(at, now)}, so the daily cron is not reaching it.`
        : `${job} last started ${formatRelativeTime(at, now)}.`,
    };
  });
}

/**
 * The most recent app-resource reconciliation sweep, as a status and a sentence.
 *
 * Mirrors `app_resource_reconcile_runs` as written by
 * `app/lib/.server/cloudflare/app-resource-reconcile-sweep.ts`, where `orphans_json` is a
 * bounded sample and `orphans_found` is the exact total. A few column names are resolved by
 * candidate so a rename degrades one clause rather than reporting a healthy zero.
 *
 * @param {Record<string, unknown>} row
 * @param {number} now
 */
export function describeReconcileRun(row, now) {
  const startedAt = number(pickColumn(row, ['started_at']), 0);
  const completedAt = number(pickColumn(row, ['completed_at', 'finished_at']), 0);
  const at = completedAt || startedAt;
  const when = formatRelativeTime(at, now, { missing: 'at an unrecorded time' });
  const runStatus = String(pickColumn(row, ['status']) ?? 'ok');
  const mode = String(pickColumn(row, ['mode']) ?? 'report');
  const users = number(pickColumn(row, ['users_scanned', 'user_count']), 0);
  const usersFailed = number(pickColumn(row, ['users_failed']), 0);
  const resources = number(pickColumn(row, ['resources_scanned', 'resource_count']), 0);
  const sample = asList(pickColumn(row, ['orphans_json', 'orphans']));
  const orphanCount = number(pickColumn(row, ['orphans_found', 'orphan_count']), sample.length);
  const deleted = number(pickColumn(row, ['deleted_count']), 0);
  const skipped = asFlag(pickColumn(row, ['listing_skipped', 'skipped_listings', 'skipped']));
  const error = cleanErrorText(pickColumn(row, ['error']));
  const orphans = sample
    .slice(0, ORPHAN_SAMPLE_LIMIT)
    .map((orphan) =>
      typeof orphan === 'string' ? orphan : `${orphan?.kind ?? 'resource'}:${orphan?.name ?? 'unnamed'}`,
    );
  const detail = {
    at,
    runStatus,
    mode,
    usersScanned: users,
    usersFailed,
    resourcesScanned: resources,
    orphanCount,
    orphans,
    deletedCount: deleted,
    skippedListing: skipped,
    error,
  };

  if (runStatus === 'running') {
    const age = ageOf(startedAt, now);
    const stuck = age !== null && age > RECONCILE_RUN_STUCK_MS;
    return {
      ...detail,
      at: startedAt,
      level: stuck ? 'error' : 'attention',
      sentence: `An app resource sweep started ${formatRelativeTime(startedAt, now)} and has not finished${stuck ? ', long past the point where one should have' : ''}.`,
    };
  }

  // The mode is always stated: report-only and enforcing are the same sentence otherwise.
  const enforcing = mode === 'enforce';
  const modeClause = enforcing
    ? `ENFORCE mode, deleting ${deleted} ${plural(deleted, 'resource')}`
    : 'report-only mode, deleting nothing';
  const scanned = ` It scanned ${resources} ${plural(resources, 'resource')} across ${users} ${plural(users, 'account')}${usersFailed > 0 ? `, and could not read ${usersFailed}` : ''}.`;

  if (error || runStatus === 'error') {
    return {
      ...detail,
      level: 'error',
      sentence: `The app resource sweep failed ${when}: ${error ?? 'no error was recorded'}.${scanned}`,
    };
  }
  if (skipped) {
    return {
      ...detail,
      level: 'attention',
      sentence: `The app resource sweep ran ${when} in ${modeClause}, but at least one resource listing could not be read, so its count of ${orphanCount} ${plural(orphanCount, 'orphan')} under-reports what is there.${scanned}`,
    };
  }
  if (orphanCount > 0) {
    const named = orphans.length > 0 ? ` (${orphans.join(', ')}${orphanCount > orphans.length ? ', …' : ''})` : '';
    return {
      ...detail,
      level: 'attention',
      sentence: `The app resource sweep nominated ${orphanCount} orphaned ${plural(orphanCount, 'resource')}${named} ${when}, running in ${modeClause}.${scanned}`,
    };
  }
  return {
    ...detail,
    level: enforcing || usersFailed > 0 ? 'attention' : 'ok',
    sentence: `The app resource sweep found no orphans ${when}, running in ${modeClause}.${scanned}`,
  };
}

/**
 * Connection statuses rolled into one health classification.
 * @param {ReadonlyArray<Record<string, unknown>>} rows grouped `status`/`count` rows
 */
export function classifyConnections(rows) {
  const byStatus = {};
  let total = 0;
  let missingCredential = 0;
  for (const row of rows) {
    const status = String(row.status ?? 'unknown');
    const count = number(row.count);
    byStatus[status] = (byStatus[status] ?? 0) + count;
    total += count;
    if (status === 'active') {
      missingCredential += number(row.missing_credential);
    }
  }
  const active = byStatus.active ?? 0;
  const broken = (byStatus.revoked ?? 0) + (byStatus.error ?? 0);
  const linking = byStatus.linking ?? 0;

  if (total === 0) {
    return {
      level: 'attention',
      sentence: 'No Cloudflare account is connected, so nothing can be built.',
      detail: { total, active, byStatus, missingCredential },
    };
  }
  const trailer = [
    broken > 0 ? `${broken} revoked or errored` : null,
    linking > 0 ? `${linking} still linking` : null,
    missingCredential > 0 ? `${missingCredential} active without a stored credential` : null,
  ].filter(Boolean);
  const level = broken > 0 || missingCredential > 0 ? 'error' : linking > 0 ? 'attention' : 'ok';
  const sentence =
    trailer.length > 0
      ? `${active} of ${total} Cloudflare ${plural(total, 'connection')} ${plural(active, 'is', 'are')} active; ${trailer.join(', ')}.`
      : `All ${total} Cloudflare ${plural(total, 'connection')} ${plural(total, 'is', 'are')} active.`;
  return { level, sentence, detail: { total, active, byStatus, missingCredential } };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The statements read in one batch. They target tables that have existed since the first
 * migration, so a failure here means Wrangler or the network, not a schema gap.
 * @param {number} now
 */
export function coreStatements(now) {
  return [
    `SELECT COUNT(*) AS total,
        SUM(CASE WHEN createdAt >= ${now - WEEK} THEN 1 ELSE 0 END) AS joined_this_week,
        SUM(CASE WHEN createdAt >= ${now - 2 * WEEK} AND createdAt < ${now - WEEK} THEN 1 ELSE 0 END) AS joined_last_week
      FROM "user"`,
    `SELECT status, COUNT(*) AS count,
        SUM(CASE WHEN credential_handle IS NULL THEN 1 ELSE 0 END) AS missing_credential
      FROM cloudflare_connections GROUP BY status`,
    `SELECT COUNT(*) AS unexpired FROM cloudflare_auth_sessions WHERE expires_at > ${now}`,
    `SELECT users.email AS email, runtimes.status AS status, runtimes.runtime_version AS runtime_version,
        runtimes.last_error AS last_error, runtimes.updated_at AS updated_at,
        runtimes.provisioning_lease_expires_at AS provisioning_lease_expires_at
      FROM "user" AS users
      JOIN cloudflare_connections AS connections ON connections.user_id = users.id
      LEFT JOIN user_computer_runtimes AS runtimes ON runtimes.user_id = users.id
      WHERE connections.status = 'active'
      ORDER BY users.createdAt
      LIMIT ${RUNTIME_ROW_LIMIT}`,
  ];
}

/**
 * Tables migrated from the operations Worker. Each is read on its own so a table that has
 * not been created yet costs one check, not the whole report. Ordered by `rowid` because the
 * timestamp column of the newest table is not settled yet.
 */
export const OPTIONAL_STATEMENTS = {
  skillSyncState: 'SELECT * FROM builder_skill_sync_state LIMIT 1',
  skillSyncRuns: 'SELECT * FROM builder_skill_sync_runs ORDER BY rowid DESC LIMIT 10',
  reconcileRuns: 'SELECT * FROM app_resource_reconcile_runs ORDER BY rowid DESC LIMIT 10',
  dailyJobs: 'SELECT * FROM daily_maintenance_jobs',
};

/**
 * Run read-only SQL against production D1 as the authenticated operator.
 *
 * @param {string} sql one or more `;`-separated SELECT statements
 * @param {{ run?: typeof execFileAsync }} [options]
 * @returns {Promise<Array<Array<Record<string, unknown>>>>} rows per statement
 */
export async function queryProduction(sql, { run = execFileAsync } = {}) {
  let stdout;
  try {
    ({ stdout } = await run(
      'pnpm',
      ['exec', 'wrangler', 'd1', 'execute', DATABASE_NAME, '--remote', '--json', '--command', sql],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
    ));
  } catch (error) {
    throw new Error(describeWranglerFailure(error));
  }
  return parseD1Response(stdout);
}

/** Turn a failed `wrangler d1 execute --json` into the one sentence an operator can act on. */
export function describeWranglerFailure(error) {
  const output = [error?.stdout, error?.stderr].filter((value) => typeof value === 'string').join('\n');
  const envelope = extractJson(output);
  const notes = Array.isArray(envelope?.error?.notes)
    ? envelope.error.notes.map((note) => note?.text).filter((text) => typeof text === 'string')
    : [];
  const message = [envelope?.error?.text, ...notes].filter(Boolean).join(' ');
  if (message) {
    return bounded(notes.length > 0 ? notes.join('; ') : message, 400);
  }
  const raw = bounded(output, 400);
  if (raw) {
    return raw;
  }
  return bounded(error?.message ?? 'Wrangler produced no output.', 400);
}

/** `wrangler --json` returns one envelope per statement; this keeps only the rows. */
export function parseD1Response(stdout) {
  const parsed = extractJson(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('Wrangler did not return a D1 result array.');
  }
  return parsed.map((result) => (Array.isArray(result?.results) ? result.results : []));
}

/** Wrangler occasionally prefixes its JSON with a blank line or a banner. */
function extractJson(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const start = text.search(/[[{]/);
  if (start < 0) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

/**
 * The workspace runtime build this checkout would provision, used as the staleness reference.
 * Generated by `pnpm run generate:user-workspace-runtime`, so it can legitimately be absent.
 */
export async function readDesiredRuntimeVersion(readFileImpl = readFile) {
  try {
    const source = await readFileImpl(RUNTIME_BUNDLE_PATH, 'utf8');
    return RUNTIME_SHA_PATTERN.exec(source)?.[1] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

/**
 * Read the platform and build the report.
 *
 * @param {{
 *   query: (sql: string) => Promise<Array<Array<Record<string, unknown>>>>;
 *   now?: number;
 *   desiredRuntimeVersion?: string | null;
 * }} options
 */
export async function collectReport({ query, now = Date.now(), desiredRuntimeVersion = null }) {
  const statements = coreStatements(now);
  const core = await attempt(() => query(statements.join(';\n')));
  const optional = Object.fromEntries(
    await Promise.all(
      Object.entries(OPTIONAL_STATEMENTS).map(async ([key, sql]) => [key, await attempt(() => query(sql))]),
    ),
  );

  const checks = [
    buildUsersCheck(core),
    buildAccountsCheck(core),
    buildSessionsCheck(core),
    buildRuntimesCheck(core, { now, desiredRuntimeVersion }),
    buildSkillSyncCheck(optional.skillSyncState, optional.skillSyncRuns, now),
    buildReconcileCheck(optional.reconcileRuns, now),
    buildDailyMaintenanceCheck(optional.dailyJobs, {
      now,
      // Each job writes a `running` receipt as its first act, so a claim newer than every
      // receipt means the job fired and died before it could record anything.
      lastReceiptAt: {
        'builder-skill-sync': newestStart(optional.skillSyncRuns),
        'app-resource-reconcile': newestStart(optional.reconcileRuns),
      },
    }),
  ];

  const ordered = CHECK_ORDER.map(({ id }) => checks.find((check) => check.id === id)).filter(Boolean);
  const status = ordered.reduce(
    (worst, check) => (STATUS_RANK[check.status] > STATUS_RANK[worst] ? check.status : worst),
    'ok',
  );
  return {
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    database: DATABASE_NAME,
    source: 'wrangler d1 execute --remote (read-only)',
    desiredRuntimeVersion,
    controlPlaneReadable: core.ok,
    status,
    headline: headlineFor(ordered, core),
    checks: ordered,
  };
}

/** Run one read and record why it failed instead of letting the failure look like emptiness. */
async function attempt(read) {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function unknownCheck(id, title, attemptResult, hint) {
  const missingTable = /no such table:\s*([\w.]+)/i.exec(attemptResult.error ?? '')?.[1] ?? null;
  return {
    id,
    title,
    status: 'unknown',
    sentence: missingTable
      ? `\`${missingTable}\` does not exist in production yet, so this is unknown.`
      : `This could not be read: ${attemptResult.error}`,
    at: null,
    relative: null,
    detail: { error: attemptResult.error, missingTable, hint: hint ?? null },
  };
}

function check(id, title, status, sentence, { at = null, now = null, detail = {} } = {}) {
  return {
    id,
    title,
    status,
    sentence,
    at,
    relative: now === null ? null : formatRelativeTime(at, now, { missing: null }),
    detail,
  };
}

function buildUsersCheck(core) {
  if (!core.ok) {
    return unknownCheck('users', 'Users', core);
  }
  const row = core.value[0]?.[0] ?? {};
  const total = number(row.total);
  const thisWeek = number(row.joined_this_week);
  const lastWeek = number(row.joined_last_week);
  const delta = thisWeek - lastWeek;
  return check(
    'users',
    'Users',
    'ok',
    `${total} ${plural(total, 'user')} in total; ${thisWeek} joined in the last 7 days (${delta >= 0 ? '+' : ''}${delta} versus the 7 days before).`,
    { detail: { total, joinedThisWeek: thisWeek, joinedPreviousWeek: lastWeek, delta } },
  );
}

function buildAccountsCheck(core) {
  if (!core.ok) {
    return unknownCheck('cloudflare-accounts', 'Cloudflare accounts', core);
  }
  const { level, sentence, detail } = classifyConnections(core.value[1] ?? []);
  return check('cloudflare-accounts', 'Cloudflare accounts', level, sentence, { detail });
}

function buildSessionsCheck(core) {
  if (!core.ok) {
    return unknownCheck('sessions', 'Sign-in sessions', core);
  }
  const unexpired = number(core.value[2]?.[0]?.unexpired);
  return check(
    'sessions',
    'Sign-in sessions',
    'ok',
    `${unexpired} unexpired sign-in ${plural(unexpired, 'session')}.`,
    { detail: { unexpired } },
  );
}

function buildRuntimesCheck(core, { now, desiredRuntimeVersion }) {
  if (!core.ok) {
    return unknownCheck('workspace-runtimes', 'Workspace runtimes', core);
  }
  const rows = core.value[3] ?? [];
  const described = rows.map((row) => describeWorkspaceRuntime(row, { now, desiredRuntimeVersion }));
  const level = described.reduce(
    (worst, entry) => (STATUS_RANK[entry.level] > STATUS_RANK[worst] ? entry.level : worst),
    'ok',
  );
  const healthy = described.filter((entry) => entry.level === 'ok').length;
  const newest = described.reduce((max, entry) => (entry.at && entry.at > max ? entry.at : max), 0);
  const sentence =
    rows.length === 0
      ? 'No connected account has a workspace runtime to report on.'
      : desiredRuntimeVersion === null
        ? `${rows.length} connected ${plural(rows.length, 'runtime')}; no local runtime build exists to measure staleness against (run \`pnpm run generate:user-workspace-runtime\`).`
        : `${healthy} of ${rows.length} workspace ${plural(rows.length, 'runtime')} ${plural(healthy, 'is', 'are')} on this checkout's current build ${shortHash(desiredRuntimeVersion)}.`;
  return check('workspace-runtimes', 'Workspace runtimes', level, sentence, {
    at: newest || null,
    now,
    detail: {
      connected: rows.length,
      current: healthy,
      desiredRuntimeVersion,
      entries: described.map(({ email, status, runtimeVersion, at, level: entryLevel, sentence: entrySentence }) => ({
        email,
        status,
        runtimeVersion,
        at,
        level: entryLevel,
        sentence: entrySentence,
      })),
    },
  });
}

function buildSkillSyncCheck(stateAttempt, runsAttempt, now) {
  if (!runsAttempt.ok) {
    return unknownCheck('builder-skill-sync', 'Builder skill sync', runsAttempt, 'Migrated from ghost-build-ops.');
  }
  const runs = runsAttempt.value[0] ?? [];
  const state = stateAttempt.ok ? (stateAttempt.value[0]?.[0] ?? null) : null;
  const lastChecked = state && Number.isFinite(state.last_checked_at) ? Number(state.last_checked_at) : null;
  const expectedGeneration = typeof state?.expected_generation === 'string' ? state.expected_generation : null;
  const stateDetail = {
    expectedGeneration,
    lastCheckedAt: lastChecked,
    activeRunId: state?.active_run_id ?? null,
    stateReadError: stateAttempt.ok ? null : stateAttempt.error,
  };

  if (runs.length === 0) {
    return check('builder-skill-sync', 'Builder skill sync', 'attention', 'No builder skill sync has ever run.', {
      now,
      detail: { ...stateDetail, runs: [] },
    });
  }
  const latest = describeSkillSyncRun(runs[0], now);
  const watcherAge = ageOf(lastChecked, now);
  const stale = watcherAge !== null && watcherAge > SCHEDULED_JOB_STALE_MS;
  const level = stale && STATUS_RANK[latest.level] < STATUS_RANK.attention ? 'attention' : latest.level;
  const sentence = stale
    ? `${latest.sentence} The watcher has not checked upstream since ${formatRelativeTime(lastChecked, now)}.`
    : latest.sentence;
  return check('builder-skill-sync', 'Builder skill sync', level, sentence, {
    at: latest.at,
    now,
    detail: {
      ...stateDetail,
      currentGeneration: typeof runs[0].generation === 'string' ? runs[0].generation : expectedGeneration,
      lastRunStatus: runs[0].status ?? null,
      runs: runs.slice(0, 5).map((run) => ({
        status: run.status ?? null,
        startedAt: Number.isFinite(run.started_at) ? Number(run.started_at) : null,
        completedAt: Number.isFinite(run.completed_at) ? Number(run.completed_at) : null,
        generation: run.generation ?? null,
        fileCount: Number.isFinite(run.file_count) ? Number(run.file_count) : null,
        error: cleanErrorText(run.error),
      })),
    },
  });
}

/** The newest `started_at` across a run-receipt table, or `null` when it could not be read. */
function newestStart(runsAttempt) {
  if (!runsAttempt?.ok) {
    return null;
  }
  return (runsAttempt.value[0] ?? []).reduce(
    (newest, row) =>
      Number.isFinite(row.started_at) && Number(row.started_at) > newest ? Number(row.started_at) : newest,
    0,
  );
}

function buildDailyMaintenanceCheck(jobsAttempt, { now, lastReceiptAt }) {
  if (!jobsAttempt.ok) {
    return unknownCheck(
      'daily-maintenance',
      'Daily maintenance',
      jobsAttempt,
      'Written by app/lib/.server/daily-maintenance.ts.',
    );
  }
  const entries = describeDailyJobs(jobsAttempt.value[0] ?? [], now).map((entry) => {
    const receipt = lastReceiptAt[entry.job];
    // The claim is written before the job runs, so a claim with no receipt behind it is a job
    // that fired and died. Only meaningful once the receipt table itself could be read.
    if (entry.level === 'ok' && entry.at !== null && receipt !== null && entry.at - receipt > DIED_AFTER_CLAIM_MS) {
      return {
        ...entry,
        level: 'error',
        sentence: `${entry.job} claimed its slot ${formatRelativeTime(entry.at, now)} but recorded no run, so it started and died.`,
      };
    }
    return entry;
  });
  const level = entries.reduce(
    (worst, entry) => (STATUS_RANK[entry.level] > STATUS_RANK[worst] ? entry.level : worst),
    'ok',
  );
  const failing = entries.filter((entry) => entry.level !== 'ok').length;
  const newest = entries.reduce((max, entry) => (entry.at && entry.at > max ? entry.at : max), 0);
  return check(
    'daily-maintenance',
    'Daily maintenance',
    level,
    failing === 0
      ? `All ${entries.length} daily maintenance ${plural(entries.length, 'job')} fired within the last day.`
      : `${failing} of ${entries.length} daily maintenance ${plural(entries.length, 'job')} did not fire as scheduled.`,
    { at: newest || null, now, detail: { entries } },
  );
}

function buildReconcileCheck(runsAttempt, now) {
  if (!runsAttempt.ok) {
    return unknownCheck(
      'app-resource-sweep',
      'App resource sweep',
      runsAttempt,
      'Written by app/lib/.server/cloudflare/app-resource-reconcile-sweep.ts.',
    );
  }
  const runs = runsAttempt.value[0] ?? [];
  if (runs.length === 0) {
    return check(
      'app-resource-sweep',
      'App resource sweep',
      'attention',
      'No app resource reconciliation sweep has been recorded yet.',
      { now, detail: { runs: [] } },
    );
  }
  // The newest row wins even if `rowid` order and timestamp order disagree.
  const described = runs.map((row) => describeReconcileRun(row, now)).sort((a, b) => b.at - a.at);
  const latest = described[0];
  const age = ageOf(latest.at, now);
  const stale = age !== null && age > SCHEDULED_JOB_STALE_MS;
  return check(
    'app-resource-sweep',
    'App resource sweep',
    stale && STATUS_RANK[latest.level] < STATUS_RANK.attention ? 'attention' : latest.level,
    stale ? `${latest.sentence} That is its last run, so the daily sweep has stopped.` : latest.sentence,
    {
      at: latest.at || null,
      now,
      detail: {
        runStatus: latest.runStatus,
        mode: latest.mode,
        usersScanned: latest.usersScanned,
        usersFailed: latest.usersFailed,
        resourcesScanned: latest.resourcesScanned,
        orphanCount: latest.orphanCount,
        orphans: latest.orphans,
        deletedCount: latest.deletedCount,
        skippedListing: latest.skippedListing,
        error: latest.error,
        recentRuns: described.slice(0, 5).map(({ at, runStatus, mode, orphanCount, skippedListing, error }) => ({
          at,
          runStatus,
          mode,
          orphanCount,
          skippedListing,
          error,
        })),
      },
    },
  );
}

/** One line that is true whether the platform is fine, broken, or partly unreadable. */
export function headlineFor(checks, core) {
  if (!core.ok) {
    return `The control plane could not be read: ${core.error}`;
  }
  const counts = { error: 0, attention: 0, unknown: 0, ok: 0 };
  for (const item of checks) {
    counts[item.status] += 1;
  }
  if (counts.error === 0 && counts.attention === 0 && counts.unknown === 0) {
    return `Everything is healthy: all ${counts.ok} checks passed.`;
  }
  // Every clause names its own noun, so any one of them can lead the sentence.
  const parts = [
    counts.error > 0 ? `${countOfChecks(counts.error)} ${plural(counts.error, 'is', 'are')} broken` : null,
    counts.attention > 0
      ? `${countOfChecks(counts.attention)} ${plural(counts.attention, 'needs', 'need')} attention`
      : null,
    counts.unknown > 0 ? `${countOfChecks(counts.unknown)} could not be read` : null,
  ].filter(Boolean);
  return `${parts.join(', ')}.`;
}

function countOfChecks(count) {
  return `${count} ${plural(count, 'check')}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const GROUPS = [
  { status: 'error', heading: 'BROKEN' },
  { status: 'attention', heading: 'NEEDS ATTENTION' },
  { status: 'unknown', heading: 'COULD NOT BE READ' },
  { status: 'ok', heading: 'HEALTHY' },
];

/**
 * The default terminal report. Broken first, healthy last, no legend required.
 * @param {ReturnType<typeof collectReport> extends Promise<infer T> ? T : never} report
 */
export function renderReport(report) {
  const lines = [
    `Ghostbuild platform — ${report.generatedAtIso.replace('T', ' ').slice(0, 16)} UTC`,
    `read-only from control-plane D1 "${report.database}" via wrangler`,
    '',
    report.headline,
  ];
  for (const { status, heading } of GROUPS) {
    const group = report.checks.filter((item) => item.status === status);
    if (group.length === 0) {
      continue;
    }
    lines.push('', heading);
    for (const item of group) {
      // The stamp only earns its place when the sentence does not already carry the same age.
      const stamp = item.relative && !item.sentence.includes(item.relative) ? ` (${item.relative})` : '';
      if (status === 'ok') {
        // Nothing to do about these, so they get one line each and stay out of the way.
        lines.push(`  ${item.title} — ${item.sentence}${stamp}`);
        continue;
      }
      lines.push(`  ${item.title}${stamp}`);
      lines.push(`    ${item.sentence}`);
      for (const extra of expandCheck(item)) {
        lines.push(`      - ${extra}`);
      }
    }
  }
  lines.push('', 'Machine-readable: pnpm run ops:json');
  return lines.join('\n');
}

/** Per-entry detail worth printing, and only for the entries that are what is wrong. */
function expandCheck(item) {
  if (item.status === 'ok' || !Array.isArray(item.detail.entries)) {
    return [];
  }
  return item.detail.entries.filter((entry) => entry.level !== 'ok').map((entry) => entry.sentence);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `Usage: pnpm run ops [-- --json]

Reports the operational state of the Ghostbuild platform by reading production
control-plane D1 with the operator's own Wrangler authentication. Read-only.

  --json   emit the structured report instead of the terminal one
  --help   show this message

Exit status is 0 whenever a report was produced, including an unhealthy one, and
1 when the control plane could not be read at all.`;

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const report = await collectReport({
    query: (sql) => queryProduction(sql),
    desiredRuntimeVersion: await readDesiredRuntimeVersion(),
  });
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
  return report.controlPlaneReadable ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
