import {
  runCloudflareSkillAudit,
  runOpenRouterCanary,
  type CloudflareSkillAuditResult,
} from './upstream-skill-audit.server';

type UpstreamMonitorSummary = {
  canary: Awaited<ReturnType<typeof runOpenRouterCanary>>;
  audit: CloudflareSkillAuditResult;
};

export async function runRecordedUpstreamMonitor(
  env: Env,
  request: typeof fetch = fetch,
): Promise<UpstreamMonitorSummary> {
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const canary = await runOpenRouterCanary(env, request);
    const audit = await runCloudflareSkillAudit(env, request);
    const summary = { canary, audit };
    const needsAttention = audit.requiresManualReview || audit.addedSkills.length > 0 || audit.removedSkills.length > 0;
    await recordRun(env.DB, {
      id,
      status: needsAttention ? 'attention' : 'ok',
      startedAt,
      summary,
    });
    return summary;
  } catch (error) {
    await recordRun(env.DB, {
      id,
      status: 'error',
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function recordRun(
  db: D1Database,
  result: {
    id: string;
    status: 'ok' | 'attention' | 'error';
    startedAt: number;
    summary?: UpstreamMonitorSummary;
    error?: string;
  },
) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO upstream_monitor_runs
           (id, status, started_at, completed_at, summary_json, error)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        result.id,
        result.status,
        result.startedAt,
        Date.now(),
        result.summary ? JSON.stringify(result.summary) : null,
        result.error?.slice(0, 2_000) ?? null,
      ),
    db.prepare(
      `DELETE FROM upstream_monitor_runs
       WHERE id NOT IN (SELECT id FROM upstream_monitor_runs ORDER BY completed_at DESC LIMIT 104)`,
    ),
  ]);
}
