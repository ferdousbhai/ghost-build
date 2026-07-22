import { deploymentPlanResourceName, type DeploymentPlan, type DeploymentResourceType } from './deployment-plan';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_API_TIMEOUT_MS = 30_000;

type WorkerBinding = {
  name?: string;
  type?: string;
  text?: string;
  database_id?: string;
};

export type ActiveWorkerDeploymentReadback = {
  providerDeploymentId: string;
  workerVersionId: string;
  scriptEtag: string;
  bindings: WorkerBinding[];
  crons: string[];
};

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
    private readonly authorizeRequest?: () => Promise<void>,
  ) {
    if (!accountId || !accessToken) {
      throw new Error('Cloudflare account credentials are required.');
    }
  }

  async createD1ForPlan(
    plan: DeploymentPlan,
    logicalName: 'DB' | 'AGENT_SECURITY_DB' = 'DB',
  ): Promise<{ id: string; name: string }> {
    const resourceName = requirePlanResourceName(plan, 'd1', logicalName);
    const result = await this.call<{ uuid?: string; name?: string }>('/d1/database', {
      method: 'POST',
      body: JSON.stringify({ name: resourceName }),
    });
    if (!result.uuid || result.name !== resourceName) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid D1 resource.');
    }
    return { id: result.uuid, name: result.name };
  }

  async ensureD1ForPlan(
    plan: DeploymentPlan,
    logicalName: 'DB' | 'AGENT_SECURITY_DB' = 'DB',
  ): Promise<{ id: string; name: string }> {
    const resourceName = requirePlanResourceName(plan, 'd1', logicalName);
    const databases = await this.call<Array<{ uuid?: string; name?: string }>>(
      `/d1/database?name=${encodeURIComponent(resourceName)}`,
      { method: 'GET' },
    );
    const existing = databases.find((database) => database.name === resourceName && database.uuid);
    return existing?.uuid ? { id: existing.uuid, name: resourceName } : this.createD1ForPlan(plan, logicalName);
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

  async ensureR2ForPlan(plan: DeploymentPlan): Promise<{ id: string; name: string }> {
    const resourceName = requirePlanResourceName(plan, 'r2', 'APP_STORAGE');
    const existing = await this.callOptional<{ name?: string }>(`/r2/buckets/${encodeURIComponent(resourceName)}`, {
      method: 'GET',
    });
    return existing?.name === resourceName ? { id: resourceName, name: resourceName } : this.createR2ForPlan(plan);
  }

  async getWorkersSubdomain(): Promise<string> {
    const result = await this.call<{ subdomain?: string }>('/workers/subdomain', { method: 'GET' });
    if (!result.subdomain || !/^[a-z0-9-]+$/.test(result.subdomain)) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid Workers subdomain.');
    }
    return result.subdomain;
  }

  /** Reads the exact version currently receiving 100% of production traffic. */
  async readActiveWorkerDeployment(workerName: string): Promise<ActiveWorkerDeploymentReadback | null> {
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(workerName)) {
      throw new CloudflareAccountApiError('Worker name is invalid.');
    }
    const listed = await this.callOptional<{
      deployments?: Array<{
        id?: string;
        created_on?: string;
        versions?: Array<{ percentage?: number; version_id?: string }>;
      }>;
    }>(`/workers/scripts/${encodeURIComponent(workerName)}/deployments`, { method: 'GET' });
    if (listed === null) {
      return null;
    }
    const active = [...(listed.deployments ?? [])].sort((left, right) =>
      (right.created_on ?? '').localeCompare(left.created_on ?? ''),
    )[0];
    const activeVersions = active?.versions?.filter((version) => version.percentage === 100) ?? [];
    if (!active?.id || activeVersions.length !== 1 || !activeVersions[0]?.version_id) {
      throw new CloudflareAccountApiError('Cloudflare returned an ambiguous active Worker deployment.');
    }
    const workerVersionId = activeVersions[0].version_id;
    const [version, schedules] = await Promise.all([
      this.call<{
        id?: string;
        resources?: { bindings?: WorkerBinding[]; script?: { etag?: string } };
      }>(`/workers/scripts/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(workerVersionId)}`, {
        method: 'GET',
      }),
      this.call<{ schedules?: Array<{ cron?: string }> }>(
        `/workers/scripts/${encodeURIComponent(workerName)}/schedules`,
        { method: 'GET' },
      ),
    ]);
    if (
      version.id !== workerVersionId ||
      !Array.isArray(version.resources?.bindings) ||
      typeof version.resources.script?.etag !== 'string' ||
      version.resources.script.etag.length < 1 ||
      version.resources.script.etag.length > 256
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid active Worker version metadata.');
    }
    return {
      providerDeploymentId: active.id,
      workerVersionId,
      scriptEtag: version.resources.script.etag,
      bindings: version.resources.bindings,
      crons: (schedules.schedules ?? []).flatMap((schedule) =>
        typeof schedule.cron === 'string' ? [schedule.cron] : [],
      ),
    };
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const result = await this.callOptional<T>(path, init);
    if (result === null) {
      throw new CloudflareAccountApiError('Cloudflare resource was not found.');
    }
    return result;
  }

  private async callOptional<T>(path: string, init: RequestInit): Promise<T | null> {
    await this.authorizeRequest?.();
    const execute = this.request;
    const response = await execute(`${API_ROOT}/accounts/${encodeURIComponent(this.accountId)}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(CLOUDFLARE_API_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    const payload = (await response.json().catch(() => null)) as CloudflareEnvelope<T> | null;
    if (response.status === 404) {
      return null;
    }
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
