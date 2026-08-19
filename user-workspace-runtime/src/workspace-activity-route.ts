/**
 * Whether any project workspace in this runtime is holding an operation lane.
 *
 * The lane lives in each per-project ProjectWorkspace Durable Object, and a Durable Object
 * namespace cannot be enumerated, so the runtime narrows the question with the activity its own D1
 * already records and then asks only those workspaces. Nothing is written on the operation hot
 * path to serve a probe that fires only after a control-plane release.
 */

/** Longer than the longest operation lease (45 minutes, deployment), so a lane acquired while a
 * candidate was last recorded is still findable when its deadline arrives. */
const ACTIVITY_WINDOW_MS = 60 * 60_000;
const MAX_ACTIVITY_CANDIDATES = 25;
const ACTIVE_DEPLOYMENT_STATUSES = ['approved', 'provisioning', 'deploying'] as const;

type OperationLaneState = { kind: string; deadline: number } | null;

type WorkspaceActivityEnv = {
  DB: Pick<D1Database, 'prepare'>;
  BuilderAgent: Pick<DurableObjectNamespace, 'idFromName'>;
  PROJECT_WORKSPACE: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): { readOperationLaneState(): Promise<OperationLaneState> };
  };
};

type UserWorkspaceRuntimeActivity = {
  busy: boolean;
  /** The lanes that were actually observed holding work, so `busy` is a reading and not a claim. */
  observed: { kind: string }[];
  /** How many workspaces the runtime could name as possibly active and therefore asked. */
  candidates: number;
  checkedAt: string;
};

/**
 * Report the workspaces holding a lane. Throws rather than reporting an idle workspace when a
 * candidate cannot be reached: an activity answer nobody could read is not evidence of idleness.
 */
export async function readUserWorkspaceRuntimeActivity(
  env: WorkspaceActivityEnv,
  now = Date.now(),
): Promise<UserWorkspaceRuntimeActivity> {
  const candidates = await activeWorkspaceCandidates(env, now - ACTIVITY_WINDOW_MS);
  const lanes = await Promise.all(
    [...candidates].map((projectId) =>
      env.PROJECT_WORKSPACE.get(env.PROJECT_WORKSPACE.idFromName(projectId)).readOperationLaneState(),
    ),
  );
  const observed = lanes.flatMap((lane) => (lane ? [{ kind: lane.kind }] : []));
  return {
    busy: observed.length > 0,
    observed,
    candidates: candidates.size,
    checkedAt: new Date(now).toISOString(),
  };
}

/**
 * The workspaces that could be holding a lane. A chat whose transcript advanced covers every lane a
 * model turn can take; an unfinished deployment covers the one lane that outlives its transcript.
 */
async function activeWorkspaceCandidates(env: WorkspaceActivityEnv, since: number): Promise<Set<string>> {
  const [transcripts, deployments] = await Promise.all([
    env.DB.prepare(
      `SELECT agent_name FROM chat_transcripts
       WHERE updated_at > ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
      .bind(since, MAX_ACTIVITY_CANDIDATES)
      .all<{ agent_name: string }>(),
    env.DB.prepare(
      `SELECT workspace_reference FROM deployments
       WHERE status IN (${ACTIVE_DEPLOYMENT_STATUSES.map(() => '?').join(', ')}) AND updated_at > ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
      .bind(...ACTIVE_DEPLOYMENT_STATUSES, since, MAX_ACTIVITY_CANDIDATES)
      .all<{ workspace_reference: string }>(),
  ]);
  const candidates = new Set<string>();
  for (const row of transcripts.results) {
    // A ProjectWorkspace is named after the BuilderAgent Durable Object id that drives it.
    candidates.add(env.BuilderAgent.idFromName(row.agent_name).toString());
  }
  for (const row of deployments.results) {
    const projectId = workspaceReferenceProjectId(row.workspace_reference);
    if (projectId) {
      candidates.add(projectId);
    }
  }
  return candidates;
}

function workspaceReferenceProjectId(reference: string): string | null {
  const match = /^workspace-runtime:([^:]+):\d+:[a-f0-9]{64}$/.exec(reference);
  return match ? decodeURIComponent(match[1]!) : null;
}
