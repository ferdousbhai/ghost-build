import { z } from 'zod';
import type { DeploymentProjectProfile } from './deployment-project-profile';
import {
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  isCurrentDeploymentSecurityIdentity,
  TEMPLATE_SOURCE_SHA256,
} from './deployment-security-baseline';

const DEPLOYMENT_PLAN_VERSION = 4 as const;

export type DeploymentResourceType = 'worker' | 'd1' | 'r2' | 'kv' | 'durable_object' | 'workers_ai';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const deploymentProjectProfileSchema: z.ZodType<DeploymentProjectProfile> = z.strictObject({
  type: z.enum(['web_app', 'worker']),
  bindings: z.strictObject({
    ai: z.boolean(),
    d1: z.boolean(),
    r2: z.boolean(),
    kv: z.boolean(),
    appAgent: z.boolean(),
  }),
});
const deploymentPlanResourceSchema = z.strictObject({
  type: z.enum(['worker', 'd1', 'r2', 'kv', 'durable_object', 'workers_ai']),
  logicalName: z.string().min(1),
  proposedName: z.string().min(1),
});
const deploymentPlanSchema = z.strictObject({
  version: z.literal(DEPLOYMENT_PLAN_VERSION),
  deploymentId: z.string().min(1),
  sourceSha256: sha256Schema,
  templateSourceSha256: sha256Schema,
  securityBaselineVersion: z.number().int().nonnegative(),
  securityBoundarySha256: sha256Schema,
  project: deploymentProjectProfileSchema,
  resources: z.array(deploymentPlanResourceSchema),
});

export type DeploymentPlan = z.infer<typeof deploymentPlanSchema>;

export async function buildDeploymentPlanFromSource(args: {
  deploymentId: string;
  sourceSha256: string;
  project: DeploymentProjectProfile;
}): Promise<{ plan: DeploymentPlan; digest: string }> {
  if (!/^[a-f0-9]{64}$/.test(args.sourceSha256)) {
    throw new Error('Deployment source digest is invalid.');
  }
  const baseName = `ghostbuild-${args.deploymentId}`;
  const project = deploymentProjectProfileSchema.parse(args.project);
  const plan: DeploymentPlan = {
    version: DEPLOYMENT_PLAN_VERSION,
    deploymentId: args.deploymentId,
    sourceSha256: args.sourceSha256,
    templateSourceSha256: TEMPLATE_SOURCE_SHA256,
    securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
    securityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
    project,
    resources: [
      { type: 'worker', logicalName: 'app', proposedName: baseName },
      ...(project.bindings.d1 ? [{ type: 'd1' as const, logicalName: 'DB', proposedName: baseName }] : []),
      ...(project.bindings.appAgent
        ? [
            {
              type: 'd1' as const,
              logicalName: 'AGENT_SECURITY_DB',
              proposedName: `${baseName}-agent-security`,
            },
          ]
        : []),
      ...(project.bindings.r2
        ? [{ type: 'r2' as const, logicalName: 'APP_STORAGE', proposedName: `${baseName}-storage` }]
        : []),
      ...(project.bindings.kv
        ? [{ type: 'kv' as const, logicalName: 'APP_CACHE', proposedName: `${baseName}-cache` }]
        : []),
      ...(project.bindings.appAgent
        ? [{ type: 'durable_object' as const, logicalName: 'AppAgent', proposedName: 'AppAgent' }]
        : []),
      ...(project.bindings.ai ? [{ type: 'workers_ai' as const, logicalName: 'AI', proposedName: 'AI' }] : []),
    ],
  };
  const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify(plan)));
  return { plan, digest };
}

export function parseDeploymentPlanJson(value: string): DeploymentPlan {
  return deploymentPlanSchema.parse(JSON.parse(value));
}

export function isCurrentDeploymentPlan(plan: unknown): plan is DeploymentPlan {
  const parsed = deploymentPlanSchema.safeParse(plan);
  if (!parsed.success || !isCurrentDeploymentSecurityIdentity(parsed.data)) {
    return false;
  }
  const current = parsed.data;
  const requiresAgentSecurityDb = current.project.bindings.appAgent;
  if (!requiresAgentSecurityDb) {
    return true;
  }
  const applicationDatabase = deploymentPlanResourceName(current, 'd1', 'DB');
  const agentSecurityDatabase = deploymentPlanResourceName(current, 'd1', 'AGENT_SECURITY_DB');
  return Boolean(applicationDatabase && agentSecurityDatabase && applicationDatabase !== agentSecurityDatabase);
}

export function deploymentProjectProfile(plan: DeploymentPlan): DeploymentProjectProfile {
  return plan.project;
}

export function deploymentPlanResourceName(
  plan: DeploymentPlan,
  type: DeploymentResourceType,
  logicalName: string,
): string | null {
  const matches = plan.resources.filter((resource) => resource.type === type && resource.logicalName === logicalName);
  const name = matches.length === 1 ? matches[0].proposedName : '';
  const valid =
    type === 'durable_object' || type === 'workers_ai'
      ? /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(name)
      : /^[a-z0-9][a-z0-9-]{2,63}$/.test(name);
  return valid ? name : null;
}

async function sha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
