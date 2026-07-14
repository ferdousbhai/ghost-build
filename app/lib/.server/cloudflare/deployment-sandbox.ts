import { ContainerProxy, Sandbox } from '@cloudflare/sandbox';
import { proxyApprovedCloudflareRequest } from './deployment-egress-proxy';

export { ContainerProxy };

/**
 * Executes generated-project builds and trusted publish commands without
 * placing a user's Cloudflare credential inside the container.
 */
export class DeploymentSandbox extends Sandbox<Env> {
  enableInternet = false;
  allowedHosts = ['registry.npmjs.org', 'api.cloudflare.com'];
  sleepAfter = '10m';
}

DeploymentSandbox.outboundByHost = {
  'api.cloudflare.com': proxyApprovedCloudflareRequest,
};
