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
  const sourceSha256 = await sha256Hex(await args.snapshot.arrayBuffer());
  return buildDeploymentPlanFromSource({ deploymentId: args.deploymentId, sourceSha256 });
}

export async function buildDeploymentPlanFromSource(args: {
  deploymentId: string;
  sourceSha256: string;
}): Promise<{ plan: DeploymentPlan; digest: string }> {
  if (!/^[a-f0-9]{64}$/.test(args.sourceSha256)) {
    throw new Error('Deployment source digest is invalid.');
  }
  const baseName = `ghostbuild-${args.deploymentId}`;
  const plan: DeploymentPlan = {
    version: DEPLOYMENT_PLAN_VERSION,
    deploymentId: args.deploymentId,
    sourceSha256: args.sourceSha256,
    billing: {
      infrastructure: 'user_cloudflare_account',
      workersAi: 'user_cloudflare_account',
      workersPaidUpgrade: 'explicit_user_authorization_required',
    },
    resources: [
      { type: 'worker', logicalName: 'app', proposedName: baseName },
      { type: 'd1', logicalName: 'DB', proposedName: baseName },
      { type: 'r2', logicalName: 'APP_STORAGE', proposedName: `${baseName}-storage` },
      { type: 'durable_object', logicalName: 'AppAgent', proposedName: 'AppAgent' },
      { type: 'workers_ai', logicalName: 'AI', proposedName: 'AI' },
    ],
  };
  const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify(plan)));
  return { plan, digest };
}

export function deploymentPlanResourceName(
  plan: DeploymentPlan,
  type: DeploymentResourceType,
  logicalName: string,
): string | null {
  const matches = plan.resources.filter((resource) => resource.type === type && resource.logicalName === logicalName);
  const name = matches.length === 1 ? matches[0].proposedName : '';
  return /^[a-z0-9][a-z0-9-]{2,63}$/.test(name) ? name : null;
}

async function sha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', ownedBytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
