import { aiAllowanceStatus, GHOSTBUILD_DAILY_AI_ALLOWANCE_USD } from '~/lib/.server/billing/ai-allowance-policy';
import { releaseStaleAiAllowanceReservations, utcUsageDate } from '~/lib/.server/billing/ai-allowance-repository';
import { resolveAgentRequestIdentity } from '~/lib/.server/agent-request-identity';
import { findCloudflareConnectionForUser } from '~/lib/.server/cloudflare/cloudflare-connection-repository';

type DailyUsageRow = {
  charged_cost_nanodollars: number;
  reserved_cost_nanodollars: number;
  last_notified_threshold: 0 | 50 | 90;
};

export async function aiAllowanceStatusAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const identity = await resolveAgentRequestIdentity(request, env);
  if (!identity) {
    return Response.json({ error: 'A guest or signed-in session is required.' }, { status: 401 });
  }
  if (identity.userId) {
    const connection = await findCloudflareConnectionForUser(env.DB, identity.userId);
    if (connection?.status === 'active' && connection.aiBillingEnabled) {
      return Response.json({ mode: 'cloudflare', reminder: 0, exhausted: false });
    }
  }
  const usageDate = utcUsageDate(new Date());
  await releaseStaleAiAllowanceReservations(env.DB, identity.billingSubjectKey, usageDate);
  const usage = await env.DB.prepare(
    `SELECT charged_cost_nanodollars, reserved_cost_nanodollars, last_notified_threshold
     FROM ai_daily_usage WHERE subject_key = ? AND usage_date = ?`,
  )
    .bind(identity.billingSubjectKey, usageDate)
    .first<DailyUsageRow>();
  const status = aiAllowanceStatus(usage?.charged_cost_nanodollars ?? 0, usage?.reserved_cost_nanodollars ?? 0);
  return Response.json({
    usageDate,
    dailyLimitUsd: GHOSTBUILD_DAILY_AI_ALLOWANCE_USD,
    usedPercent: status.usedPercent,
    exhausted: status.exhausted,
    reminder: usage?.last_notified_threshold ?? status.reminder,
  });
}
