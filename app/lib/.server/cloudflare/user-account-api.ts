import { deploymentPlanResourceName, type DeploymentPlan, type DeploymentResourceType } from './deployment-plan';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_API_TIMEOUT_MS = 30_000;
const R2_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

type WorkerBinding = {
  name?: string;
  type?: string;
  text?: string;
  database_id?: string;
};

type DurableObjectNamespaceReadback = {
  id?: string;
  class?: string;
  script?: string;
  use_sqlite?: boolean;
};

type ContainerApplicationReadback = {
  id?: string;
  name?: string;
  durable_objects?: { namespace_id?: string };
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

  async ensureD1Database(resourceName: string): Promise<{ id: string; name: string }> {
    requireCloudflareResourceName(resourceName);
    const databases = await this.call<Array<{ uuid?: string; name?: string }>>(
      `/d1/database?name=${encodeURIComponent(resourceName)}`,
      { method: 'GET' },
    );
    const existing = databases.find((database) => database.name === resourceName && database.uuid);
    if (existing?.uuid) {
      return { id: existing.uuid, name: resourceName };
    }
    const result = await this.call<{ uuid?: string; name?: string }>('/d1/database', {
      method: 'POST',
      body: JSON.stringify({ name: resourceName }),
    });
    if (!result.uuid || result.name !== resourceName) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid D1 resource.');
    }
    return { id: result.uuid, name: result.name };
  }

  async executeD1(databaseId: string, sql: string, params: unknown[] = []): Promise<unknown> {
    if (!/^[0-9a-f-]{32,64}$/i.test(databaseId) || !sql.trim()) {
      throw new CloudflareAccountApiError('Invalid D1 query.');
    }
    return this.call<unknown>(`/d1/database/${encodeURIComponent(databaseId)}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql, params }),
    });
  }

  async applyD1Migrations(databaseId: string, migrations: readonly { name: string; sql: string }[]): Promise<void> {
    await this.executeD1(
      databaseId,
      `CREATE TABLE IF NOT EXISTS ghostbuild_runtime_migrations (
         name TEXT PRIMARY KEY NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
    );
    for (const migration of migrations) {
      if (!/^\d{4}_.+\.sql$/.test(migration.name) || !migration.sql.trim()) {
        throw new CloudflareAccountApiError('Invalid user-runtime D1 migration.');
      }
      const read = (await this.executeD1(databaseId, 'SELECT name FROM ghostbuild_runtime_migrations WHERE name = ?', [
        migration.name,
      ])) as Array<{ results?: unknown[] }>;
      if (read.some((result) => (result.results?.length ?? 0) > 0)) {
        continue;
      }
      await this.executeD1(databaseId, migration.sql);
      await this.executeD1(
        databaseId,
        'INSERT OR IGNORE INTO ghostbuild_runtime_migrations (name, applied_at) VALUES (?, ?)',
        [migration.name, Date.now()],
      );
    }
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

  private async createR2Bucket(resourceName: string): Promise<{ id: string; name: string }> {
    requireR2BucketName(resourceName);
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
    return this.ensureR2Bucket(resourceName);
  }

  async ensureR2Bucket(resourceName: string): Promise<{ id: string; name: string }> {
    requireR2BucketName(resourceName);
    const existing = await this.callOptional<{ name?: string }>(`/r2/buckets/${encodeURIComponent(resourceName)}`, {
      method: 'GET',
    });
    if (existing?.name === resourceName) {
      return { id: resourceName, name: resourceName };
    }
    try {
      return await this.createR2Bucket(resourceName);
    } catch (error) {
      if (!(error instanceof CloudflareAccountApiError)) {
        throw error;
      }
      const raced = await this.callOptional<{ name?: string }>(`/r2/buckets/${encodeURIComponent(resourceName)}`, {
        method: 'GET',
      });
      if (raced?.name === resourceName) {
        return { id: resourceName, name: resourceName };
      }
      throw error;
    }
  }

  async getWorkersSubdomain(): Promise<string> {
    const result = await this.call<{ subdomain?: string }>('/workers/subdomain', { method: 'GET' });
    if (!result.subdomain || !/^[a-z0-9-]+$/.test(result.subdomain)) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid Workers subdomain.');
    }
    return result.subdomain;
  }

  async deployWorkspaceRuntimeWorker(args: {
    workerName: string;
    source: string;
    bucketName: string;
    controlPlaneSecret: string;
    r2AccessKeyId: string;
    r2SecretAccessKey: string;
    runtimeVersion: string;
    databaseId: string;
    apiToken: string;
    userId: string;
    connectionId: string;
    connectionGeneration: number;
    endpoint: string;
  }): Promise<{ workerVersionId: string; namespaceId: string }> {
    requireWorkerName(args.workerName);
    requireR2BucketName(args.bucketName);
    if (!/^[a-f0-9]{64}$/.test(args.runtimeVersion) || args.controlPlaneSecret.length < 32) {
      throw new CloudflareAccountApiError('The workspace runtime identity is invalid.');
    }
    if (!args.r2AccessKeyId || !args.r2SecretAccessKey || !args.apiToken || !args.userId) {
      throw new CloudflareAccountApiError('R2 backup credentials are required.');
    }
    const metadata = {
      main_module: 'workspace-runtime.mjs',
      compatibility_date: '2026-07-27',
      compatibility_flags: ['nodejs_compat'],
      containers: [{ class_name: 'WorkspaceSandbox' }],
      bindings: [
        { type: 'durable_object_namespace', name: 'WORKSPACE_SANDBOX', class_name: 'WorkspaceSandbox' },
        { type: 'durable_object_namespace', name: 'BuilderAgent', class_name: 'BuilderAgent' },
        { type: 'd1', name: 'DB', id: args.databaseId },
        { type: 'ai', name: 'AI' },
        { type: 'r2_bucket', name: 'BACKUP_BUCKET', bucket_name: args.bucketName },
        { type: 'secret_text', name: 'CONTROL_PLANE_SECRET', text: args.controlPlaneSecret },
        { type: 'secret_text', name: 'CLOUDFLARE_API_TOKEN', text: args.apiToken },
        { type: 'secret_text', name: 'R2_ACCESS_KEY_ID', text: args.r2AccessKeyId },
        { type: 'secret_text', name: 'R2_SECRET_ACCESS_KEY', text: args.r2SecretAccessKey },
        { type: 'plain_text', name: 'BACKUP_BUCKET_NAME', text: args.bucketName },
        { type: 'plain_text', name: 'CLOUDFLARE_ACCOUNT_ID', text: this.accountId },
        { type: 'plain_text', name: 'GHOSTBUILD_USER_ID', text: args.userId },
        { type: 'plain_text', name: 'GHOSTBUILD_CONNECTION_ID', text: args.connectionId },
        {
          type: 'plain_text',
          name: 'GHOSTBUILD_CONNECTION_GENERATION',
          text: String(args.connectionGeneration),
        },
        { type: 'plain_text', name: 'GHOSTBUILD_USER_RUNTIME_ENDPOINT', text: args.endpoint },
        { type: 'plain_text', name: 'GHOSTBUILD_USER_RUNTIME', text: '1' },
        { type: 'plain_text', name: 'GHOSTBUILD_RUNTIME_VERSION', text: args.runtimeVersion },
      ],
      exports: {
        WorkspaceSandbox: {
          type: 'durable-object',
          storage: 'sqlite',
          container: 'WorkspaceSandbox',
        },
        BuilderAgent: {
          type: 'durable-object',
          storage: 'sqlite',
        },
      },
      observability: { enabled: true, logs: { enabled: true, head_sampling_rate: 1 } },
      annotations: {
        'workers/message': `Ghostbuild user-owned workspace runtime ${args.runtimeVersion.slice(0, 12)}`,
        'workers/tag': args.runtimeVersion.slice(0, 64),
      },
    };
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.set(
      'workspace-runtime.mjs',
      new Blob([args.source], { type: 'application/javascript+module' }),
      'workspace-runtime.mjs',
    );
    const response = await this.callRaw(`/workers/scripts/${encodeURIComponent(args.workerName)}`, {
      method: 'PUT',
      body: form,
    });
    const result = await parseCloudflareEnvelope<{
      id?: string;
      deployment_id?: string;
      version_id?: string;
    }>(response);
    const workerVersionId = result.version_id ?? result.deployment_id ?? result.id;
    if (!workerVersionId) {
      throw new CloudflareAccountApiError('Cloudflare did not identify the workspace runtime deployment.');
    }
    const namespaces = await this.call<DurableObjectNamespaceReadback[]>(
      '/workers/durable_objects/namespaces?per_page=1000',
      { method: 'GET' },
    );
    const namespace = namespaces.find(
      (candidate) =>
        candidate.script === args.workerName &&
        candidate.class === 'WorkspaceSandbox' &&
        candidate.use_sqlite === true &&
        candidate.id,
    );
    if (!namespace?.id) {
      throw new CloudflareAccountApiError('Cloudflare did not provision the workspace Sandbox namespace.');
    }
    return { workerVersionId, namespaceId: namespace.id };
  }

  async ensureWorkspaceRuntimeContainer(args: {
    applicationName: string;
    namespaceId: string;
    image: string;
    maxInstances?: number;
  }): Promise<{ id: string; name: string }> {
    requireWorkerName(args.applicationName);
    if (!/^[0-9a-f-]{32,64}$/i.test(args.namespaceId)) {
      throw new CloudflareAccountApiError('The workspace Sandbox namespace is invalid.');
    }
    if (!/^docker\.io\/[a-z0-9._/-]+:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/.test(args.image)) {
      throw new CloudflareAccountApiError('The workspace Sandbox image is not immutable.');
    }
    const applications = await this.callContainer<ContainerApplicationReadback[]>('/applications', {
      method: 'GET',
    });
    const existing = applications.find((candidate) => candidate.name === args.applicationName);
    if (existing?.durable_objects?.namespace_id && existing.durable_objects.namespace_id !== args.namespaceId) {
      throw new CloudflareAccountApiError(
        'The workspace container name is already attached to a different Durable Object namespace.',
      );
    }
    const configuration = {
      configuration: {
        image: args.image,
        instance_type: 'basic',
        observability: { logs: { enabled: true } },
        wrangler_ssh: false,
      },
      max_instances: args.maxInstances ?? 10,
      constraints: { tiers: [1, 2] },
      scheduling_policy: 'default',
      rollout_active_grace_period: 0,
    };
    const result = existing?.id
      ? await this.callContainer<ContainerApplicationReadback>(`/applications/${encodeURIComponent(existing.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(configuration),
        })
      : await this.callContainer<ContainerApplicationReadback>('/applications', {
          method: 'POST',
          body: JSON.stringify({
            name: args.applicationName,
            ...configuration,
            instances: 0,
            durable_objects: { namespace_id: args.namespaceId },
          }),
        });
    if (!result.id || result.name !== args.applicationName) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid workspace container application.');
    }
    return { id: result.id, name: result.name };
  }

  async enableWorkerSubdomain(workerName: string): Promise<void> {
    requireWorkerName(workerName);
    await this.call<unknown>(`/workers/scripts/${encodeURIComponent(workerName)}/subdomain`, {
      method: 'POST',
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
    });
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
    const response = await this.callRaw(path, {
      ...init,
      headers: {
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

  private async callRaw(path: string, init: RequestInit): Promise<Response> {
    await this.authorizeRequest?.();
    const execute = this.request;
    return execute(`${API_ROOT}/accounts/${encodeURIComponent(this.accountId)}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(CLOUDFLARE_API_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...init.headers,
      },
    });
  }

  private async callContainer<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.callRaw(`/containers${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    const payload = (await response.json().catch(() => null)) as
      CloudflareEnvelope<T> | T | { error?: string; message?: string } | null;
    if (!response.ok || payload === null) {
      const message =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (('message' in payload && typeof payload.message === 'string' ? payload.message : undefined) ??
            ('error' in payload && typeof payload.error === 'string' ? payload.error : undefined))
          : undefined;
      throw new CloudflareAccountApiError(message || `Cloudflare Containers request failed (${response.status}).`);
    }
    if (typeof payload === 'object' && !Array.isArray(payload) && 'success' in payload) {
      const envelope = payload as CloudflareEnvelope<T>;
      if (envelope.success !== true || envelope.result === undefined) {
        throw new CloudflareAccountApiError(
          envelope.errors?.find((error) => error.message)?.message || 'Cloudflare Containers request failed.',
        );
      }
      return envelope.result;
    }
    return payload as T;
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

function requireR2BucketName(name: string): void {
  if (!R2_BUCKET_NAME_PATTERN.test(name)) {
    throw new CloudflareAccountApiError('R2 bucket name is invalid.');
  }
}

function requireWorkerName(name: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new CloudflareAccountApiError('Worker name is invalid.');
  }
}

function requireCloudflareResourceName(name: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new CloudflareAccountApiError('Cloudflare resource name is invalid.');
  }
}

async function parseCloudflareEnvelope<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as CloudflareEnvelope<T> | null;
  if (!response.ok || payload?.success !== true || payload.result === undefined) {
    throw new CloudflareAccountApiError(
      payload?.errors?.find((error) => error.message)?.message || `Cloudflare API request failed (${response.status}).`,
    );
  }
  return payload.result;
}
