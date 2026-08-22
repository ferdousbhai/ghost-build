import { z } from 'zod';
import {
  USER_WORKSPACE_RUNTIME_SERVICE,
  type UserWorkspaceReadinessCheck,
  type UserWorkspaceReadinessComponent,
} from '@ghostbuild/user-workspace-runtime/protocol';

type RuntimeHealthEnv = {
  DB: Pick<D1Database, 'prepare'>;
  GHOSTBUILD_RUNTIME_VERSION: string;
};

type UserWorkspaceRuntimeHealth = {
  ok: true;
  service: typeof USER_WORKSPACE_RUNTIME_SERVICE;
  runtimeVersion: string;
};

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

const readinessCheckSchema = z.object({
  ok: z.boolean(),
  code: z.string().min(1),
  durationMs: z.number().int().min(0),
}) satisfies z.ZodType<UserWorkspaceReadinessCheck>;

const readinessComponentsSchema = z.object({
  runtime: readinessCheckSchema,
  database: readinessCheckSchema,
  projectWorkspaceRpc: readinessCheckSchema,
  durableVfs: readinessCheckSchema,
  container: readinessCheckSchema,
  fuse: readinessCheckSchema,
  sync: readinessCheckSchema,
  cleanup: readinessCheckSchema,
}) satisfies z.ZodType<Record<UserWorkspaceReadinessComponent, UserWorkspaceReadinessCheck>>;

const runtimeReadinessSchema = z.looseObject({
  ok: z.boolean(),
  service: z.literal(USER_WORKSPACE_RUNTIME_SERVICE),
  runtimeVersion: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  components: readinessComponentsSchema,
}) satisfies z.ZodType<UserWorkspaceRuntimeReadiness>;

/** Decode the readiness payload a user-owned runtime reports about itself. */
export function parseUserWorkspaceRuntimeReadiness(payload: unknown): UserWorkspaceRuntimeReadiness {
  const readiness = runtimeReadinessSchema.safeParse(payload);
  if (!readiness.success) {
    throw new Error('The user-owned workspace runtime did not pass its readiness check.');
  }
  return readiness.data;
}
