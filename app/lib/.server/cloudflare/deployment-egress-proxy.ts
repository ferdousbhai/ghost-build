import { requireActiveCloudflareConnection } from './cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { listDeploymentResources, requireDeployment } from './deployment-repository';
import {
  DeploymentProxyTokenError,
  parseDeploymentPublishContainerId,
  verifyDeploymentProxyToken,
} from './deployment-proxy-token';

type OutboundContext = { containerId: string };

export async function proxyApprovedCloudflareRequest(
  request: Request,
  env: Env,
  context: OutboundContext,
): Promise<Response> {
  try {
    if (!env.DEPLOYMENT_PROXY_JWT_SECRET || !env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
      return new Response('Deployment proxy is not configured.', { status: 503 });
    }
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.hostname !== 'api.cloudflare.com') {
      return new Response('Destination denied.', { status: 403 });
    }
    if (isAssetsUploadRequest(request.method, url)) {
      return proxyAssetsUploadRequest(request, env, context, url);
    }
    const bearer = readBearer(request.headers.get('authorization'));
    const claims = await verifyDeploymentProxyToken({
      token: bearer,
      secretBase64: env.DEPLOYMENT_PROXY_JWT_SECRET,
      expectedContainerId: context.containerId,
    });
    const deployment = await requireDeployment(env.DB, claims.deploymentId);
    if (
      deployment.status !== 'deploying' ||
      deployment.connectionGeneration !== claims.connectionGeneration ||
      deployment.executionGeneration !== claims.executionGeneration ||
      deployment.planDigest !== claims.planDigest ||
      deployment.approvedDigest !== claims.planDigest
    ) {
      return new Response('Deployment state denied.', { status: 409 });
    }
    const connection = await requireActiveCloudflareConnection(env.DB, deployment.connectionId);
    if (
      connection.generation !== claims.connectionGeneration ||
      connection.accountId !== claims.accountId ||
      !connection.credentialHandle
    ) {
      return new Response('Cloudflare connection denied.', { status: 403 });
    }
    const resources = await listDeploymentResources(env.DB, deployment.id);
    if (!isApprovedCloudflareApiRequest(request.method, url, claims.accountId, deployment.plan, resources)) {
      return new Response('Cloudflare API operation denied by the approved deployment plan.', { status: 403 });
    }
    const accessToken = await D1CloudflareCredentialVault.fromEnv(env).resolve(connection.credentialHandle);
    const upstream = new Request(request);
    upstream.headers.set('authorization', `Bearer ${accessToken}`);
    return fetch(upstream);
  } catch (error) {
    if (error instanceof DeploymentProxyTokenError) {
      return new Response(error.message, { status: 401 });
    }
    console.error('Cloudflare deployment egress proxy failed', error);
    return new Response('Cloudflare deployment proxy failed.', { status: 502 });
  }
}

export function isApprovedCloudflareApiRequest(
  method: string,
  url: URL,
  accountId: string,
  plan: { resources: Array<{ type: string; logicalName: string; proposedName: string }> },
  provisioned: Array<{ resourceType: string; logicalName: string; providerResourceId: string }>,
): boolean {
  if (url.hostname !== 'api.cloudflare.com' || url.protocol !== 'https:') {
    return false;
  }
  const path = decodeURIComponent(url.pathname);
  if (method === 'GET' && path === '/client/v4/user/tokens/verify') {
    return true;
  }
  const accountRoot = `/client/v4/accounts/${accountId}`;
  if (!path.startsWith(`${accountRoot}/`) && path !== accountRoot) {
    return false;
  }
  if (method === 'GET' && (path === accountRoot || path === `${accountRoot}/workers/subdomain`)) {
    return true;
  }

  const workerName = plan.resources.find(
    (resource) => resource.type === 'worker' && resource.logicalName === 'app',
  )?.proposedName;
  if (workerName && path === `${accountRoot}/workers/scripts/${workerName}` && method === 'PUT') {
    return true;
  }
  if (workerName && path === `${accountRoot}/workers/scripts/${workerName}/schedules` && method === 'PUT') {
    return true;
  }
  if (
    workerName &&
    path === `${accountRoot}/workers/scripts/${workerName}/assets-upload-session` &&
    method === 'POST'
  ) {
    return true;
  }

  const approvedD1Ids = provisioned.flatMap((resource) =>
    resource.resourceType === 'd1' && (resource.logicalName === 'DB' || resource.logicalName === 'AGENT_SECURITY_DB')
      ? [resource.providerResourceId]
      : [],
  );
  for (const d1Id of approvedD1Ids) {
    if (path === `${accountRoot}/d1/database/${d1Id}/query` && method === 'POST') {
      return true;
    }
    if (path === `${accountRoot}/d1/database/${d1Id}` && method === 'GET') {
      return true;
    }
  }
  if (method === 'GET' && path === `${accountRoot}/r2/buckets`) {
    return true;
  }
  return false;
}

async function proxyAssetsUploadRequest(
  request: Request,
  env: Env,
  context: OutboundContext,
  url: URL,
): Promise<Response> {
  const container = parseDeploymentPublishContainerId(context.containerId);
  if (!container) {
    return new Response('Asset upload denied.', { status: 403 });
  }
  const deployment = await requireDeployment(env.DB, container.deploymentId);
  if (
    deployment.status !== 'deploying' ||
    deployment.connectionGeneration !== container.connectionGeneration ||
    deployment.executionGeneration !== container.executionGeneration
  ) {
    return new Response('Asset upload denied.', { status: 409 });
  }
  const connection = await requireActiveCloudflareConnection(env.DB, deployment.connectionId);
  if (connection.generation !== container.connectionGeneration) {
    return new Response('Asset upload denied.', { status: 403 });
  }
  const accountRoot = `/client/v4/accounts/${connection.accountId}`;
  const path = decodeURIComponent(url.pathname);
  const exactBulkPath = `${accountRoot}/workers/assets/upload`;
  const singleAssetPattern = new RegExp(`^${escapeRegExp(exactBulkPath)}/[a-f0-9]{32,64}$`);
  if (request.method !== 'POST' || (path !== exactBulkPath && !singleAssetPattern.test(path))) {
    return new Response('Asset upload denied.', { status: 403 });
  }
  // The assets API issues this narrowly scoped completion token after the
  // plan-authorized upload-session request. Preserve it rather than replacing
  // it with the user's account credential.
  if (!/^Bearer \S+$/.test(request.headers.get('authorization') ?? '')) {
    return new Response('Asset upload authorization is invalid.', { status: 401 });
  }
  return fetch(request);
}

function isAssetsUploadRequest(method: string, url: URL): boolean {
  return method === 'POST' && /\/client\/v4\/accounts\/[^/]+\/workers\/assets\/upload(?:\/|$)/.test(url.pathname);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readBearer(value: string | null): string {
  const match = /^Bearer (\S+)$/.exec(value ?? '');
  if (!match) {
    throw new DeploymentProxyTokenError();
  }
  return match[1];
}
