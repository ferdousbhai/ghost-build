import { deploymentPlanResourceName, type DeploymentPlan, type DeploymentResourceType } from './deployment-plan';

const API_ROOT = 'https://api.cloudflare.com/client/v4';

type CloudflareEnvelope<T> = {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
};

export class UserCloudflareAccountApi {
  constructor(
    private readonly accountId: string,
    private readonly accessToken: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!accountId || !accessToken) {
      throw new Error('Cloudflare account credentials are required.');
    }
  }

  async createD1ForPlan(plan: DeploymentPlan): Promise<{ id: string; name: string }> {
    const resourceName = requirePlanResourceName(plan, 'd1', 'DB');
    const result = await this.call<{ uuid?: string; name?: string }>('/d1/database', {
      method: 'POST',
      body: JSON.stringify({ name: resourceName }),
    });
    if (!result.uuid || result.name !== resourceName) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid D1 resource.');
    }
    return { id: result.uuid, name: result.name };
  }

  async createR2ForPlan(plan: DeploymentPlan): Promise<{ id: string; name: string }> {
    const resourceName = requirePlanResourceName(plan, 'r2', 'APP_STORAGE');
    const result = await this.call<{ name?: string }>('/r2/buckets', {
      method: 'POST',
      body: JSON.stringify({ name: resourceName }),
    });
    if (result.name !== resourceName) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid R2 resource.');
    }
    return { id: result.name, name: result.name };
  }

  async getWorkersSubdomain(): Promise<string> {
    const result = await this.call<{ subdomain?: string }>('/workers/subdomain', { method: 'GET' });
    if (!result.subdomain || !/^[a-z0-9-]+$/.test(result.subdomain)) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid Workers subdomain.');
    }
    return result.subdomain;
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const execute = this.request;
    const response = await execute(`${API_ROOT}/accounts/${encodeURIComponent(this.accountId)}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    const payload = (await response.json().catch(() => null)) as CloudflareEnvelope<T> | null;
    if (!response.ok || payload?.success !== true || payload.result === undefined) {
      const providerMessage = payload?.errors?.find((error) => error.message)?.message;
      throw new CloudflareAccountApiError(providerMessage || `Cloudflare API request failed (${response.status}).`);
    }
    return payload.result;
  }
}

export class CloudflareAccountApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareAccountApiError';
  }
}

function requirePlanResourceName(plan: DeploymentPlan, type: DeploymentResourceType, logicalName: string): string {
  const name = deploymentPlanResourceName(plan, type, logicalName);
  if (!name) {
    throw new CloudflareAccountApiError(`Approved deployment plan has an invalid ${type} resource.`);
  }
  return name;
}
