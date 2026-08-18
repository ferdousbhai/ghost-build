import {
  buildBuilderSkillGeneration,
  hasSignificantSkillChanges,
  publishBuilderSkillGeneration,
  readPublishedPointerSnapshot,
  resolveSourceRevisions,
  sourceConfigurationFingerprint,
  validatePublishedGeneration,
  type PackedBuilderSkills,
  type SourceRevision,
} from './generation';
import { BUILDER_SKILL_SOURCES } from './upstream-sources';

/**
 * Ghostbuild is the only writer of the owner-published builder skill tree.
 *
 * The mirror used to live on a separate operations Worker so that exactly one deployment could
 * publish a generation; folding it back in here keeps that property rather than dropping it -
 * `builder_skill_sync_state` holds a single-row lease, so two overlapping cron invocations still
 * produce one publisher. Local `builder-skills:publish` refuses `--remote` for the same reason.
 */
const STALE_LOCK_MS = 20 * 60 * 1_000;

type SyncState = {
  published_revisions_json: string;
  source_config_fingerprint: string;
  expected_generation: string | null;
};

type WatchResult = {
  status: 'unchanged' | 'busy' | 'published';
  revisions: SourceRevision[];
  generation?: string;
  runId: string;
};

/** Reconcile selected upstream skill trees to one complete, immutable R2 generation. */
export async function runUpstreamWatcher(
  env: Env,
  request: typeof fetch = fetch,
  now = Date.now(),
): Promise<WatchResult> {
  const runId = crypto.randomUUID();
  await createRun(env.DB, runId, now);
  let observed: SourceRevision[] | null = null;
  let previousGeneration: string | null = null;
  let candidate: PackedBuilderSkills | null = null;
  let lockHeld = false;

  try {
    const configFingerprint = await ensureSyncState(env.DB, now);
    await releaseStaleLock(env.DB, now);
    lockHeld = await acquireLock(env.DB, runId, now);
    if (!lockHeld) {
      await finishBusyRun(env.DB, runId, now);
      return { status: 'busy', revisions: [], runId };
    }

    observed = await resolveSourceRevisions(request);
    const state = await requireSyncState(env.DB);
    const publishedRevisions = parseRevisions(state.published_revisions_json);
    const pointerSnapshot = await readPublishedPointerSnapshot(env.BUILDER_SKILLS);
    previousGeneration = pointerSnapshot.pointer?.generation ?? null;
    const pointerHealthy = pointerSnapshot.pointer
      ? await validatePublishedGeneration(env.BUILDER_SKILLS, pointerSnapshot.pointer)
      : false;
    const revisionsMatch = sameRevisions(publishedRevisions, observed);
    const configurationMatches = state.source_config_fingerprint === configFingerprint;
    const expectedPointerMatches =
      Boolean(state.expected_generation) && state.expected_generation === pointerSnapshot.pointer?.generation;

    await updateObservation(env.DB, runId, observed, now);
    if (revisionsMatch && configurationMatches && expectedPointerMatches && pointerHealthy) {
      await finishSuccessfulRun(
        env.DB,
        runId,
        'unchanged',
        observed,
        configFingerprint,
        pointerSnapshot.pointer!.generation,
        now,
      );
      lockHeld = false;
      return {
        status: 'unchanged',
        revisions: observed,
        generation: pointerSnapshot.pointer!.generation,
        runId,
      };
    }

    if (
      !revisionsMatch &&
      configurationMatches &&
      expectedPointerMatches &&
      pointerHealthy &&
      !(await hasSignificantSkillChanges(publishedRevisions, observed, request))
    ) {
      await finishSuccessfulRun(
        env.DB,
        runId,
        'unchanged',
        observed,
        configFingerprint,
        pointerSnapshot.pointer!.generation,
        now,
      );
      lockHeld = false;
      return {
        status: 'unchanged',
        revisions: observed,
        generation: pointerSnapshot.pointer!.generation,
        runId,
      };
    }

    candidate = await buildBuilderSkillGeneration(observed, request);
    if (pointerSnapshot.pointer?.generation === candidate.generation && pointerHealthy) {
      await finishSuccessfulRun(
        env.DB,
        runId,
        'unchanged',
        observed,
        configFingerprint,
        candidate.generation,
        now,
        candidate.files.length,
      );
      lockHeld = false;
      return {
        status: 'unchanged',
        revisions: observed,
        generation: candidate.generation,
        runId,
      };
    }

    const confirmed = await resolveSourceRevisions(request);
    if (!sameRevisionArrays(confirmed, observed)) {
      throw new Error('Upstream skill revisions changed while preparing publication.');
    }
    await assertLockOwned(env.DB, runId);
    await publishBuilderSkillGeneration(env.BUILDER_SKILLS, candidate, pointerSnapshot);
    await finishSuccessfulRun(
      env.DB,
      runId,
      'published',
      observed,
      configFingerprint,
      candidate.generation,
      Date.now(),
      candidate.files.length,
      previousGeneration,
    );
    lockHeld = false;
    return {
      status: 'published',
      revisions: observed,
      generation: candidate.generation,
      runId,
    };
  } catch (error) {
    const message = cleanError(error);
    await finishFailedRun(env.DB, runId, Date.now(), {
      revisions: observed,
      previousGeneration,
      generation: candidate?.generation ?? null,
      fileCount: candidate?.files.length ?? null,
      error: message,
      releaseLock: lockHeld,
    }).catch((receiptError) => {
      console.error('Failed to record builder skill sync error', {
        runId,
        error: cleanError(receiptError),
        originalError: message,
      });
    });
    throw error;
  }
}

async function ensureSyncState(db: D1Database, now: number): Promise<string> {
  const initialRevisions = configuredPublishedRevisions();
  const configFingerprint = await sourceConfigurationFingerprint();
  await db
    .prepare(
      `INSERT OR IGNORE INTO builder_skill_sync_state
         (singleton, published_revisions_json, source_config_fingerprint,
          expected_generation, last_observed_revisions_json, last_checked_at)
       VALUES (1, ?, ?, NULL, ?, ?)`,
    )
    .bind(JSON.stringify(initialRevisions), configFingerprint, JSON.stringify(initialRevisions), now)
    .run();
  return configFingerprint;
}

async function createRun(db: D1Database, runId: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO builder_skill_sync_runs (id, status, started_at)
       VALUES (?, 'running', ?)`,
    )
    .bind(runId, now)
    .run();
}

async function releaseStaleLock(db: D1Database, now: number): Promise<void> {
  const stale = await db
    .prepare(
      `SELECT active_run_id FROM builder_skill_sync_state
       WHERE singleton = 1 AND active_run_id IS NOT NULL
         AND (active_run_started_at IS NULL OR active_run_started_at <= ?)`,
    )
    .bind(now - STALE_LOCK_MS)
    .first<{ active_run_id: string }>();
  if (!stale) {
    return;
  }
  await db.batch([
    db
      .prepare(
        `UPDATE builder_skill_sync_state
         SET active_run_id = NULL, active_run_started_at = NULL
         WHERE singleton = 1 AND active_run_id = ?`,
      )
      .bind(stale.active_run_id),
    db
      .prepare(
        `UPDATE builder_skill_sync_runs
         SET status = 'error', completed_at = ?, error = ?
         WHERE id = ? AND status = 'running'`,
      )
      .bind(now, 'Builder skill sync lease expired.', stale.active_run_id),
  ]);
}

async function acquireLock(db: D1Database, runId: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE builder_skill_sync_state
       SET active_run_id = ?, active_run_started_at = ?
       WHERE singleton = 1 AND active_run_id IS NULL`,
    )
    .bind(runId, now)
    .run();
  return result.meta.changes === 1;
}

async function assertLockOwned(db: D1Database, runId: string): Promise<void> {
  const row = await db
    .prepare(`SELECT active_run_id FROM builder_skill_sync_state WHERE singleton = 1`)
    .first<{ active_run_id: string | null }>();
  if (row?.active_run_id !== runId) {
    throw new Error('Builder skill publication lock was lost.');
  }
}

async function requireSyncState(db: D1Database): Promise<SyncState> {
  const state = await db
    .prepare(
      `SELECT published_revisions_json, source_config_fingerprint, expected_generation
       FROM builder_skill_sync_state WHERE singleton = 1`,
    )
    .first<SyncState>();
  if (!state) {
    throw new Error('Builder skill sync state is unavailable.');
  }
  parseRevisions(state.published_revisions_json);
  return state;
}

async function updateObservation(
  db: D1Database,
  runId: string,
  revisions: SourceRevision[],
  now: number,
): Promise<void> {
  const serialized = JSON.stringify(revisions);
  await db.batch([
    db
      .prepare(
        `UPDATE builder_skill_sync_state
         SET last_observed_revisions_json = ?, last_checked_at = ?
         WHERE singleton = 1 AND active_run_id = ?`,
      )
      .bind(serialized, now, runId),
    db
      .prepare(
        `UPDATE builder_skill_sync_runs SET source_revisions_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .bind(serialized, runId),
  ]);
}

async function finishSuccessfulRun(
  db: D1Database,
  runId: string,
  status: 'unchanged' | 'published',
  revisions: SourceRevision[],
  configFingerprint: string,
  generation: string,
  completedAt: number,
  fileCount: number | null = null,
  previousGeneration: string | null = null,
): Promise<void> {
  const serialized = JSON.stringify(revisions);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE builder_skill_sync_state
         SET published_revisions_json = ?, source_config_fingerprint = ?,
             expected_generation = ?, last_observed_revisions_json = ?,
             last_checked_at = ?, active_run_id = NULL, active_run_started_at = NULL
         WHERE singleton = 1 AND active_run_id = ?`,
      )
      .bind(serialized, configFingerprint, generation, serialized, completedAt, runId),
    db
      .prepare(
        `UPDATE builder_skill_sync_runs
         SET status = ?, completed_at = ?, source_revisions_json = ?,
             previous_generation = ?, generation = ?, file_count = ?
         WHERE id = ? AND status = 'running'`,
      )
      .bind(status, completedAt, serialized, previousGeneration, generation, fileCount, runId),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new Error('Builder skill sync finalization lost its publication lock.');
  }
}

async function finishBusyRun(db: D1Database, runId: string, completedAt: number): Promise<void> {
  await db
    .prepare(
      `UPDATE builder_skill_sync_runs
       SET status = 'busy', completed_at = ?, error = ?
       WHERE id = ? AND status = 'running'`,
    )
    .bind(completedAt, 'Another builder skill sync is active.', runId)
    .run();
}

async function finishFailedRun(
  db: D1Database,
  runId: string,
  completedAt: number,
  fields: {
    revisions: SourceRevision[] | null;
    previousGeneration: string | null;
    generation: string | null;
    fileCount: number | null;
    error: string;
    releaseLock: boolean;
  },
): Promise<void> {
  const statements = [
    db
      .prepare(
        `UPDATE builder_skill_sync_runs
         SET status = 'error', completed_at = ?, source_revisions_json = COALESCE(?, source_revisions_json),
             previous_generation = ?, generation = ?, file_count = ?, error = ?
         WHERE id = ? AND status = 'running'`,
      )
      .bind(
        completedAt,
        fields.revisions ? JSON.stringify(fields.revisions) : null,
        fields.previousGeneration,
        fields.generation,
        fields.fileCount,
        fields.error,
        runId,
      ),
  ];
  if (fields.releaseLock) {
    statements.push(
      db
        .prepare(
          `UPDATE builder_skill_sync_state
           SET active_run_id = NULL, active_run_started_at = NULL
           WHERE singleton = 1 AND active_run_id = ?`,
        )
        .bind(runId),
    );
  }
  await db.batch(statements);
}

function configuredPublishedRevisions(): SourceRevision[] {
  return BUILDER_SKILL_SOURCES.map(({ id, repository, publishedRevision: revision }) => ({
    id,
    repository,
    revision,
  }));
}

function parseRevisions(value: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Stored builder skill source revisions are invalid.');
  }
  if (
    !Array.isArray(parsed) ||
    new Set(parsed.map((entry) => (entry as SourceRevision)?.id)).size !== parsed.length ||
    !parsed.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof (entry as SourceRevision).id === 'string' &&
        typeof (entry as SourceRevision).repository === 'string' &&
        typeof (entry as SourceRevision).revision === 'string' &&
        /^[a-f0-9]{40}$/.test((entry as SourceRevision).revision),
    )
  ) {
    throw new Error('Stored builder skill source revisions are invalid.');
  }
  return new Map((parsed as SourceRevision[]).map(({ id, revision }) => [id, revision]));
}

function sameRevisions(published: ReadonlyMap<string, string>, observed: readonly SourceRevision[]): boolean {
  return observed.every(({ id, revision }) => published.get(id) === revision);
}

function sameRevisionArrays(left: readonly SourceRevision[], right: readonly SourceRevision[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, ' ').trim().slice(0, 2_000);
}
