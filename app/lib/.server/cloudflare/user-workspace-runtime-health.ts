export const USER_WORKSPACE_RUNTIME_SERVICE = 'ghostbuild-user-workspace-runtime';

type RuntimeHealthEnv = {
  DB: Pick<D1Database, 'prepare'>;
  GHOSTBUILD_RUNTIME_VERSION: string;
};

type UserWorkspaceRuntimeHealth = {
  ok: true;
  service: typeof USER_WORKSPACE_RUNTIME_SERVICE;
  runtimeVersion: string;
};

export const USER_WORKSPACE_READINESS_COMPONENTS = [
  'runtime',
  'database',
  'projectWorkspaceRpc',
  'durableVfs',
  'workerShell',
  'container',
  'fuse',
  'sync',
  'cleanup',
] as const;

export type UserWorkspaceReadinessComponent = (typeof USER_WORKSPACE_READINESS_COMPONENTS)[number];
export type UserWorkspaceReadinessCheck = { ok: boolean; code: string; durationMs: number };
type UserWorkspaceRuntimeReadiness = {
  ok: boolean;
  service: typeof USER_WORKSPACE_RUNTIME_SERVICE;
  runtimeVersion: string;
  checkedAt: string;
  components: Record<UserWorkspaceReadinessComponent, UserWorkspaceReadinessCheck>;
};

/** Prove that the deployed Worker can read its required D1 binding. */
export async function readUserWorkspaceRuntimeHealth(env: RuntimeHealthEnv): Promise<UserWorkspaceRuntimeHealth> {
  if (!/^[a-f0-9]{64}$/.test(env.GHOSTBUILD_RUNTIME_VERSION)) {
    throw new Error('The workspace runtime version binding is invalid.');
  }
  const database = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  if (database?.ok !== 1) {
    throw new Error('The workspace runtime database is unavailable.');
  }
  return {
    ok: true,
    service: USER_WORKSPACE_RUNTIME_SERVICE,
    runtimeVersion: env.GHOSTBUILD_RUNTIME_VERSION,
  };
}

export function requireExpectedUserWorkspaceRuntimeHealth(payload: unknown, runtimeVersion: string): void {
  const health = parseUserWorkspaceRuntimeHealth(payload);
  if (health.runtimeVersion !== runtimeVersion) {
    throw new Error('The user-owned workspace runtime did not pass its health check.');
  }
}

function parseUserWorkspaceRuntimeHealth(payload: unknown): UserWorkspaceRuntimeHealth {
  if (
    !isRecord(payload) ||
    payload.ok !== true ||
    payload.service !== USER_WORKSPACE_RUNTIME_SERVICE ||
    typeof payload.runtimeVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.runtimeVersion)
  ) {
    throw new Error('The user-owned workspace runtime did not pass its health check.');
  }
  return payload as UserWorkspaceRuntimeHealth;
}

export function parseUserWorkspaceRuntimeReadiness(payload: unknown): UserWorkspaceRuntimeReadiness {
  if (
    !isRecord(payload) ||
    typeof payload.ok !== 'boolean' ||
    payload.service !== USER_WORKSPACE_RUNTIME_SERVICE ||
    typeof payload.runtimeVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.runtimeVersion) ||
    typeof payload.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(payload.checkedAt)) ||
    !isRecord(payload.components)
  ) {
    throw new Error('The user-owned workspace runtime did not pass its readiness check.');
  }
  for (const name of USER_WORKSPACE_READINESS_COMPONENTS) {
    const component = payload.components[name];
    if (
      !isRecord(component) ||
      typeof component.ok !== 'boolean' ||
      typeof component.code !== 'string' ||
      component.code.length === 0 ||
      typeof component.durationMs !== 'number' ||
      !Number.isSafeInteger(component.durationMs) ||
      component.durationMs < 0
    ) {
      throw new Error('The user-owned workspace runtime did not pass its readiness check.');
    }
  }
  return payload as UserWorkspaceRuntimeReadiness;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
