import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { runAppResourceReconciliation } from '~/lib/.server/cloudflare/app-resource-reconcile-sweep';

/**
 * Jobs that want a day between runs, hosted on a cron that fires every fifteen minutes.
 *
 * The Worker cron exists for authentication-metadata retention, which wants to run often. This
 * job came from a retired operations Worker whose own cron was `23 5 * * *`, so it claims a slot
 * in D1 and skips the other ninety-five ticks of the day.
 *
 * The claim is an elapsed interval rather than a wall-clock window on purpose: a window at a
 * fixed hour silently loses a day whenever a deploy, an outage, or a cold Worker eats that one
 * tick, whereas an interval only ever delays the next run. The claim is written before the job
 * runs, so a job that throws waits out the interval instead of retrying every fifteen minutes.
 */
const DAILY_MAINTENANCE_INTERVAL_MS = 23 * 60 * 60 * 1000;

const logger = createScopedLogger('DailyMaintenance');

const dailyJobs = {
  'app-resource-reconcile': (env: Env) => runAppResourceReconciliation(env),
} satisfies Record<string, (env: Env) => Promise<unknown>>;

/**
 * Run each daily job whose claim is due. Each job records its own outcome in D1, so a failure
 * here is logged and dropped rather than allowed to abort the rest of the scheduled sweep.
 */
export async function runDailyMaintenance(env: Env, now = Date.now()): Promise<void> {
  for (const [job, run] of Object.entries(dailyJobs)) {
    if (!(await claimDailyJob(env.DB, job, now))) {
      continue;
    }
    try {
      await run(env);
    } catch (error) {
      logger.error(`Daily maintenance job ${job} failed`, error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Claim the job's slot for this run, or report that it is not due yet.
 *
 * SQLite applies the conflicting update only when its own `WHERE` still holds, so two overlapping
 * cron invocations cannot both come away with a claim: exactly one sees a changed row.
 */
async function claimDailyJob(db: D1Database, job: string, now: number): Promise<boolean> {
  try {
    const result = await db
      .prepare(
        `INSERT INTO daily_maintenance_jobs (job, last_started_at)
         VALUES (?, ?)
         ON CONFLICT(job) DO UPDATE SET last_started_at = excluded.last_started_at
         WHERE daily_maintenance_jobs.last_started_at <= ?`,
      )
      .bind(job, now, now - DAILY_MAINTENANCE_INTERVAL_MS)
      .run();
    return result.meta.changes === 1;
  } catch (error) {
    // An unclaimable slot means the job does not run this tick, never that it runs unclaimed.
    // The reason travels with it: a missing table and a contended row both stop the job here,
    // and only the message says which one to go and fix.
    logger.error(
      `Unable to claim the daily maintenance slot for ${job}`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
