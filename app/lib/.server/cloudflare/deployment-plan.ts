import { inspectDeploymentSnapshot, type DeploymentProjectProfile } from './deployment-snapshot';

export const DEPLOYMENT_PLAN_VERSION = 1 as const;

export type DeploymentResourceType = 'worker' | 'd1' | 'r2' | 'durable_object' | 'workers_ai';

export type DeploymentPlanResource = {
  type: DeploymentResourceType;
  logicalName: string;
  proposedName: string;
};

export type DeploymentPlan = {
  version: typeof DEPLOYMENT_PLAN_VERSION;
  deploymentId: string;
  sourceSha256: string;
  project?: DeploymentProjectProfile;
  billing: {
    infrastructure: 'user_cloudflare_account';
    workersAi: 'user_cloudflare_account';
    workersPaidUpgrade: 'explicit_user_authorization_required';
  };
  resources: DeploymentPlanResource[];
};

export async function buildDeploymentPlan(args: {
  deploymentId: string;
  snapshot: Blob;
}): Promise<{ plan: DeploymentPlan; digest: string }> {
  const source = await args.snapshot.arrayBuffer();
  const [sourceSha256, project] = await Promise.all([sha256Hex(source), inspectDeploymentSnapshot(source)]);
  return buildDeploymentPlanFromSource({ deploymentId: args.deploymentId, sourceSha256, project });
}

export async function buildDeploymentPlanFromSource(args: {
  deploymentId: string;
  sourceSha256: string;
  project?: DeploymentProjectProfile;
}): Promise<{ plan: DeploymentPlan; digest: string }> {
  if (!/^[a-f0-9]{64}$/.test(args.sourceSha256)) {
    throw new Error('Deployment source digest is invalid.');
  }
  const baseName = `ghostbuild-${args.deploymentId}`;
  const project = args.project ?? defaultWebProjectProfile();
  const plan: DeploymentPlan = {
    version: DEPLOYMENT_PLAN_VERSION,
    deploymentId: args.deploymentId,
    sourceSha256: args.sourceSha256,
    project,
    billing: {
      infrastructure: 'user_cloudflare_account',
      workersAi: 'user_cloudflare_account',
      workersPaidUpgrade: 'explicit_user_authorization_required',
    },
    resources: [
      { type: 'worker', logicalName: 'app', proposedName: baseName },
      ...(project.bindings.d1 ? [{ type: 'd1' as const, logicalName: 'DB', proposedName: baseName }] : []),
      ...(project.bindings.r2
        ? [{ type: 'r2' as const, logicalName: 'APP_STORAGE', proposedName: `${baseName}-storage` }]
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

export function deploymentProjectProfile(plan: DeploymentPlan): DeploymentProjectProfile {
  return plan.project ?? defaultWebProjectProfile();
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

function defaultWebProjectProfile(): DeploymentProjectProfile {
  return { type: 'web_app', bindings: { ai: true, d1: true, r2: true, appAgent: true } };
}
