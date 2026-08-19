import { z } from 'zod';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';

export const USER_WORKSPACE_ACTIVITY_PATH = '/v1/activity';
const ACTIVITY_REQUEST_TIMEOUT_MS = 5_000;
const MAX_ACTIVITY_RESPONSE_BYTES = 8 * 1024;

/**
 * What the control plane learned about work in flight inside a user-owned runtime.
 *
 * `unreported` and `unknown` are kept apart because they are different facts. A runtime that
 * refuses or does not recognise this route states definitely that it cannot be asked; anything
 * else that goes wrong leaves the question genuinely unanswered.
 */
type UserWorkspaceRuntimeActivityStatus = 'busy' | 'idle' | 'unreported' | 'unknown';

/**
 * A runtime deployed before this route existed answers 401, because it sees the control-plane
 * secret as a capability token it cannot verify; one that recognises the route but rejects the
 * secret answers the same. Both mean this runtime will never report activity to this control
 * plane, and both are repaired by the upgrade that is being decided, so neither may defer it.
 */
const CANNOT_REPORT_ACTIVITY_STATUSES = new Set([401, 403, 404]);

const activitySchema = z.looseObject({ busy: z.boolean() });

export async function readUserWorkspaceRuntimeActivity(args: {
  endpoint: string;
  controlPlaneSecret: string;
  request?: typeof fetch;
  timeoutMs?: number;
}): Promise<UserWorkspaceRuntimeActivityStatus> {
  let url: string;
  try {
    const parsed = new URL(
      USER_WORKSPACE_ACTIVITY_PATH,
      args.endpoint.endsWith('/') ? args.endpoint : `${args.endpoint}/`,
    );
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return 'unknown';
    }
    url = parsed.toString();
  } catch {
    return 'unknown';
  }
  if (args.controlPlaneSecret.length < 32) {
    return 'unknown';
  }
  try {
    const response = await (args.request ?? fetch)(url, {
      headers: { authorization: `Bearer ${args.controlPlaneSecret}` },
      signal: AbortSignal.timeout(args.timeoutMs ?? ACTIVITY_REQUEST_TIMEOUT_MS),
    });
    if (CANNOT_REPORT_ACTIVITY_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return 'unreported';
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return 'unknown';
    }
    const payload = await readJsonBodyWithLimit(response, MAX_ACTIVITY_RESPONSE_BYTES, 'Workspace runtime activity');
    const activity = activitySchema.safeParse(payload);
    if (!activity.success) {
      return 'unknown';
    }
    return activity.data.busy ? 'busy' : 'idle';
  } catch {
    return 'unknown';
  }
}
