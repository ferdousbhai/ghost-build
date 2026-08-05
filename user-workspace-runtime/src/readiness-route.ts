import {
  readUserWorkspaceRuntimeHealth,
  USER_WORKSPACE_READINESS_COMPONENTS,
  USER_WORKSPACE_RUNTIME_SERVICE,
  type UserWorkspaceReadinessCheck,
  type UserWorkspaceReadinessComponent,
} from '../../app/lib/.server/cloudflare/user-workspace-runtime-health';

const READINESS_WORKSPACE_NAME = 'ghostbuild-runtime-readiness';
const WORKSPACE_COMPONENTS = ['durableVfs', 'container', 'fuse', 'sync', 'cleanup'] as const;

type WorkspaceReadinessProbe = {
  ok: boolean;
  components: Partial<Record<UserWorkspaceReadinessComponent, UserWorkspaceReadinessCheck>>;
};

type RuntimeReadinessEnv = {
  CONTROL_PLANE_SECRET: string;
  GHOSTBUILD_RUNTIME_VERSION: string;
  DB: Pick<D1Database, 'prepare'>;
  PROJECT_WORKSPACE: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): { runReadinessProbe(): Promise<WorkspaceReadinessProbe> };
  };
};

/** Route the raw-secret-authenticated probes used while provisioning a user runtime. */
export async function routeUserWorkspaceRuntimeControlPlaneRequest(
  request: Request,
  env: RuntimeReadinessEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method !== 'GET' || path !== '/v1/readiness') {
    return null;
  }
  if (!authorized(request, env.CONTROL_PLANE_SECRET)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders() });
  }
  return readUserWorkspaceRuntimeReadiness(env);
}

async function readUserWorkspaceRuntimeReadiness(env: RuntimeReadinessEnv): Promise<Response> {
  const components = {} as Partial<Record<UserWorkspaceReadinessComponent, UserWorkspaceReadinessCheck>>;
  const runtimeStartedAt = Date.now();
  const runtimeReady = /^[a-f0-9]{64}$/.test(env.GHOSTBUILD_RUNTIME_VERSION);
  components.runtime = check(runtimeReady, runtimeReady ? 'version_ready' : 'invalid_version', runtimeStartedAt);

  if (runtimeReady) {
    const databaseStartedAt = Date.now();
    try {
      await readUserWorkspaceRuntimeHealth(env);
      components.database = check(true, 'query_ready', databaseStartedAt);
    } catch {
      components.database = check(false, 'query_failed', databaseStartedAt);
    }
  } else {
    components.database = blockedCheck();
  }

  if (components.database.ok) {
    const rpcStartedAt = Date.now();
    try {
      const id = env.PROJECT_WORKSPACE.idFromName(READINESS_WORKSPACE_NAME);
      const probe = await env.PROJECT_WORKSPACE.get(id).runReadinessProbe();
      requireWorkspaceProbe(probe);
      components.projectWorkspaceRpc = check(true, 'rpc_ready', rpcStartedAt);
      for (const name of WORKSPACE_COMPONENTS) {
        components[name] = probe.components[name]!;
      }
    } catch {
      components.projectWorkspaceRpc = check(false, 'rpc_failed', rpcStartedAt);
      blockWorkspaceComponents(components);
    }
  } else {
    components.projectWorkspaceRpc = blockedCheck();
    blockWorkspaceComponents(components);
  }

  const complete = components as Record<UserWorkspaceReadinessComponent, UserWorkspaceReadinessCheck>;
  const ok = USER_WORKSPACE_READINESS_COMPONENTS.every((name) => complete[name].ok);
  return Response.json(
    {
      ok,
      service: USER_WORKSPACE_RUNTIME_SERVICE,
      runtimeVersion: env.GHOSTBUILD_RUNTIME_VERSION,
      checkedAt: new Date().toISOString(),
      components: complete,
    },
    { status: ok ? 200 : 503, headers: noStoreHeaders() },
  );
}

function requireWorkspaceProbe(value: WorkspaceReadinessProbe): void {
  if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean' || !value.components) {
    throw new Error('ProjectWorkspace returned an invalid readiness result.');
  }
  for (const name of WORKSPACE_COMPONENTS) {
    const component = value.components[name];
    if (
      !component ||
      typeof component.ok !== 'boolean' ||
      typeof component.code !== 'string' ||
      component.code.length === 0 ||
      !Number.isSafeInteger(component.durationMs) ||
      component.durationMs < 0
    ) {
      throw new Error('ProjectWorkspace returned an invalid readiness result.');
    }
  }
}

function blockWorkspaceComponents(
  components: Partial<Record<UserWorkspaceReadinessComponent, UserWorkspaceReadinessCheck>>,
): void {
  for (const name of WORKSPACE_COMPONENTS) {
    components[name] = blockedCheck();
  }
}

function check(ok: boolean, code: string, startedAt: number): UserWorkspaceReadinessCheck {
  return { ok, code, durationMs: Math.max(0, Date.now() - startedAt) };
}

function blockedCheck(): UserWorkspaceReadinessCheck {
  return { ok: false, code: 'blocked_by_dependency', durationMs: 0 };
}

function noStoreHeaders(): HeadersInit {
  return { 'cache-control': 'no-store' };
}

function authorized(request: Request, expected: string): boolean {
  const value = request.headers.get('authorization');
  if (!value?.startsWith('Bearer ') || expected.length < 32) {
    return false;
  }
  const supplied = value.slice('Bearer '.length);
  if (supplied.length !== expected.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}
