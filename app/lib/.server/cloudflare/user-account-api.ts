import { deploymentPlanResourceName, type DeploymentPlan, type DeploymentResourceType } from './deployment-plan';
import { deploymentAssetExtension, deploymentAssetHash, type DeploymentArtifactFile } from './deployment-artifact';
import {
  APP_AGENT_DECLARATIVE_EXPORT,
  DEPLOYMENT_COMPATIBILITY_DATE,
  DEPLOYMENT_COMPATIBILITY_FLAGS,
  DEPLOYMENT_OBSERVABILITY,
  DEPLOYMENT_SECURITY_BASELINE_BINDING,
  DEPLOYMENT_SECURITY_BOUNDARY_BINDING,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
  DEPLOYMENT_TEMPLATE_SOURCE_BINDING,
  DEPLOYMENT_VERSION_METADATA_BINDING,
} from './deployment-runtime-policy';
import {
  PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
  PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES,
} from './project-workspace-container-policy';
import { GHOSTBUILD_CONTROL_PLANE_ENDPOINT, USER_WORKSPACE_RUNTIME_GC_CRON } from './user-workspace-runtime-policy';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_API_TIMEOUT_MS = 30_000;
const MAX_CLOUDFLARE_RESPONSE_BYTES = 1024 * 1024;
const MAX_ASSET_UPLOAD_JWT_BYTES = 16 * 1024;
const ASSET_HASH_PATTERN = /^[a-f0-9]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  compatibilityDate: string;
  compatibilityFlags: string[];
};

type CloudflareEnvelope<T> = {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
};

type D1QueryResult = {
  success?: boolean;
  results?: unknown[];
};

export class UserCloudflareAccountApi {
  constructor(
    private readonly accountId: string,
    private accessToken: string,
    private readonly request: typeof fetch = fetch,
    private readonly authorizeRequest?: () => Promise<void>,
    private readonly refreshAccessToken?: () => Promise<string>,
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
    const databases = await this.call<unknown>(`/d1/database?name=${encodeURIComponent(resourceName)}`, {
      method: 'GET',
    });
    const existingId = existingD1DatabaseId(databases, resourceName);
    if (existingId) {
      return { id: existingId, name: resourceName };
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

  async executeD1(databaseId: string, sql: string, params: unknown[] = []): Promise<D1QueryResult[]> {
    if (!sql.trim()) {
      throw new CloudflareAccountApiError('Invalid D1 query.');
    }
    return this.executeD1Payload(databaseId, { sql, params });
  }

  private async executeD1Batch(
    databaseId: string,
    batch: readonly { sql: string; params?: unknown[] }[],
  ): Promise<D1QueryResult[]> {
    if (batch.length === 0 || batch.some((statement) => !statement.sql.trim())) {
      throw new CloudflareAccountApiError('Invalid D1 query batch.');
    }
    return this.executeD1Payload(databaseId, {
      batch: batch.map((statement) => ({ sql: statement.sql, params: statement.params ?? [] })),
    });
  }

  private async executeD1Payload(databaseId: string, payload: Record<string, unknown>): Promise<D1QueryResult[]> {
    if (!/^[0-9a-f-]{32,64}$/i.test(databaseId)) {
      throw new CloudflareAccountApiError('Invalid D1 query.');
    }
    const result = await this.call<unknown>(`/d1/database/${encodeURIComponent(databaseId)}/query`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (
      !Array.isArray(result) ||
      result.length === 0 ||
      result.some(
        (query) =>
          !isRecord(query) || query.success !== true || (query.results !== undefined && !Array.isArray(query.results)),
      )
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned an unsuccessful D1 query result.');
    }
    return result as D1QueryResult[];
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
      const read = await this.executeD1(databaseId, 'SELECT name FROM ghostbuild_runtime_migrations WHERE name = ?', [
        migration.name,
      ]);
      if (read.some((result) => (result.results?.length ?? 0) > 0)) {
        continue;
      }
      try {
        await this.executeD1Batch(databaseId, [
          { sql: migration.sql },
          {
            sql: 'INSERT OR IGNORE INTO ghostbuild_runtime_migrations (name, applied_at) VALUES (?, ?)',
            params: [migration.name, Date.now()],
          },
        ]);
      } catch (error) {
        // A lost acknowledgement after D1 commits must not replay a
        // non-idempotent migration. Resolve the ambiguity by reading its
        // transactional marker before surfacing the original failure.
        const committed = await this.executeD1(
          databaseId,
          'SELECT name FROM ghostbuild_runtime_migrations WHERE name = ?',
          [migration.name],
        ).catch(() => []);
        if (committed.some((result) => (result.results?.length ?? 0) > 0)) {
          continue;
        }
        throw error;
      }
    }
  }

  async ensureD1ForPlan(
    plan: DeploymentPlan,
    logicalName: 'DB' | 'AGENT_SECURITY_DB' = 'DB',
  ): Promise<{ id: string; name: string }> {
    const resourceName = requirePlanResourceName(plan, 'd1', logicalName);
    const databases = await this.call<unknown>(`/d1/database?name=${encodeURIComponent(resourceName)}`, {
      method: 'GET',
    });
    const existingId = existingD1DatabaseId(databases, resourceName);
    return existingId ? { id: existingId, name: resourceName } : this.createD1ForPlan(plan, logicalName);
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
    if (existing !== null && existing.name !== resourceName) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid R2 resource.');
    }
    if (existing) {
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
      if (raced !== null && raced.name !== resourceName) {
        throw new CloudflareAccountApiError('Cloudflare returned an invalid R2 resource.');
      }
      if (raced) {
        return { id: resourceName, name: resourceName };
      }
      throw error;
    }
  }

  /** Upload an immutable, server-owned Worker version and promote exactly it to production. */
  async deployManagedWorker(args: {
    workerName: string;
    projectType: 'web_app' | 'worker';
    sourceSha256: string;
    mainModule: string;
    modules: readonly DeploymentArtifactFile[];
    assets: readonly DeploymentArtifactFile[];
    workersAi: boolean;
    appAgent: boolean;
    d1DatabaseId?: string;
    agentSecurityD1DatabaseId?: string;
    r2BucketName?: string;
    securityBaselineVersion: string;
    securityBoundarySha256: string;
    templateSourceSha256: string;
  }): Promise<{ workerVersionId: string }> {
    requireWorkerName(args.workerName);
    const expectedMain = args.projectType === 'worker' ? 'server.js' : 'index.js';
    if (
      args.mainModule !== expectedMain ||
      !/^[a-f0-9]{64}$/.test(args.sourceSha256) ||
      args.modules.filter((module) => module.path === expectedMain).length !== 1 ||
      (args.projectType === 'worker' && args.assets.length !== 0)
    ) {
      throw new CloudflareAccountApiError('Managed Worker deployment artifact is invalid.');
    }

    const assetJwt =
      args.projectType === 'web_app' ? await this.uploadStaticAssets(args.workerName, args.assets) : undefined;
    const bindings: Array<Record<string, unknown>> = [
      { type: 'version_metadata', name: DEPLOYMENT_VERSION_METADATA_BINDING },
      { type: 'plain_text', name: DEPLOYMENT_SECURITY_BASELINE_BINDING, text: args.securityBaselineVersion },
      { type: 'plain_text', name: DEPLOYMENT_SECURITY_BOUNDARY_BINDING, text: args.securityBoundarySha256 },
      { type: 'plain_text', name: DEPLOYMENT_TEMPLATE_SOURCE_BINDING, text: args.templateSourceSha256 },
      ...(args.workersAi ? [{ type: 'ai', name: 'AI' }] : []),
      ...(args.d1DatabaseId ? [{ type: 'd1', name: 'DB', id: args.d1DatabaseId }] : []),
      ...(args.agentSecurityD1DatabaseId
        ? [{ type: 'd1', name: 'AGENT_SECURITY_DB', id: args.agentSecurityD1DatabaseId }]
        : []),
      ...(args.r2BucketName ? [{ type: 'r2_bucket', name: 'APP_STORAGE', bucket_name: args.r2BucketName }] : []),
      ...(args.appAgent ? [{ type: 'durable_object_namespace', name: 'AppAgent', class_name: 'AppAgent' }] : []),
    ];
    const metadata = {
      main_module: expectedMain,
      compatibility_date: DEPLOYMENT_COMPATIBILITY_DATE,
      compatibility_flags: [...DEPLOYMENT_COMPATIBILITY_FLAGS],
      bindings,
      ...(assetJwt ? { assets: { jwt: assetJwt } } : {}),
      ...(args.appAgent ? { exports: { AppAgent: APP_AGENT_DECLARATIVE_EXPORT } } : {}),
      observability: DEPLOYMENT_OBSERVABILITY,
      annotations: {
        'workers/message': `Ghostbuild approved revision ${args.sourceSha256.slice(0, 12)}`,
        'workers/tag': args.sourceSha256,
      },
    };
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    for (const module of args.modules) {
      form.set(
        module.path,
        new Blob([new Uint8Array(module.bytes).buffer], { type: workerModuleContentType(module.path) }),
        module.path,
      );
    }
    const version = await parseCloudflareEnvelope<{ id?: string }>(
      await this.callRaw(`/workers/scripts/${encodeURIComponent(args.workerName)}/versions`, {
        method: 'POST',
        body: form,
      }),
    );
    if (!version.id || !UUID_PATTERN.test(version.id)) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid Worker version identity.');
    }
    await this.promoteWorkerVersion(args.workerName, version.id, args.sourceSha256);
    return { workerVersionId: version.id };
  }

  /** Replace every trigger with the one server-owned AppAgent cleanup schedule, or none. */
  async configureManagedWorkerSchedule(workerName: string, appAgent: boolean): Promise<void> {
    requireWorkerName(workerName);
    const expected = appAgent ? [DEPLOYMENT_SECURITY_CLEANUP_CRON] : [];
    const result = await this.call<{ schedules?: Array<{ cron?: string }> }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/schedules`,
      {
        method: 'PUT',
        body: JSON.stringify(expected.map((cron) => ({ cron }))),
      },
    );
    requireExactSchedules(result, expected);
    const readback = await this.call<{ schedules?: Array<{ cron?: string }> }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/schedules`,
      { method: 'GET' },
    );
    requireExactSchedules(readback, expected);
  }

  private async readExactWorkerSubdomainState(workerName: string): Promise<void> {
    const state = await this.call<{ enabled?: boolean; previews_enabled?: boolean }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
      { method: 'GET' },
    );
    if (state.enabled !== true || state.previews_enabled !== false) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker subdomain state.');
    }
  }

  private async uploadStaticAssets(workerName: string, assets: readonly DeploymentArtifactFile[]): Promise<string> {
    try {
      return await this.uploadStaticAssetsOnce(workerName, assets);
    } catch (error) {
      if (!(error instanceof AssetUploadSessionExpiredError)) {
        throw error;
      }
      return this.uploadStaticAssetsOnce(workerName, assets);
    }
  }

  private async uploadStaticAssetsOnce(workerName: string, assets: readonly DeploymentArtifactFile[]): Promise<string> {
    const byHash = new Map<string, DeploymentArtifactFile>();
    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const asset of assets) {
      const hash = await deploymentAssetHash(asset);
      const existing = byHash.get(hash);
      if (
        !ASSET_HASH_PATTERN.test(hash) ||
        (existing !== undefined &&
          (deploymentAssetExtension(existing.path) !== deploymentAssetExtension(asset.path) ||
            !equalBytes(existing.bytes, asset.bytes)))
      ) {
        throw new CloudflareAccountApiError('Managed Worker assets contain an invalid content hash collision.');
      }
      if (!existing) {
        byHash.set(hash, asset);
      }
      manifest[`/${asset.path}`] = { hash, size: asset.size };
    }
    const session = await this.call<{ jwt?: string; buckets?: unknown }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/assets-upload-session`,
      { method: 'POST', body: JSON.stringify({ manifest }) },
    );
    let completionJwt = requireAssetUploadJwt(session.jwt);
    if (!Array.isArray(session.buckets) || session.buckets.length > byHash.size) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid asset upload buckets.');
    }
    const requested = new Set<string>();
    let receivedCompletionJwt = session.buckets.length === 0;
    for (const [bucketIndex, rawBucket] of session.buckets.entries()) {
      if (!Array.isArray(rawBucket) || rawBucket.length === 0 || rawBucket.length > byHash.size) {
        throw new CloudflareAccountApiError('Cloudflare returned invalid asset upload buckets.');
      }
      const form = new FormData();
      for (const rawHash of rawBucket) {
        if (typeof rawHash !== 'string' || !ASSET_HASH_PATTERN.test(rawHash) || requested.has(rawHash)) {
          throw new CloudflareAccountApiError('Cloudflare returned invalid asset upload buckets.');
        }
        const asset = byHash.get(rawHash);
        if (!asset) {
          throw new CloudflareAccountApiError('Cloudflare requested an unknown managed Worker asset.');
        }
        requested.add(rawHash);
        form.set(
          rawHash,
          new Blob([bytesToBase64(asset.bytes)], { type: staticAssetContentType(asset.path) }),
          rawHash,
        );
      }
      const response = await this.executeRaw(
        '/workers/assets/upload?base64=true',
        { method: 'POST', body: form },
        completionJwt,
      );
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        throw new AssetUploadSessionExpiredError();
      }
      const finalBucket = bucketIndex === session.buckets.length - 1;
      if (response.status !== (finalBucket ? 201 : 200)) {
        throw new CloudflareAccountApiError('Cloudflare returned an invalid asset upload status sequence.');
      }
      const uploaded = await parseCloudflareEnvelope<{ jwt?: string }>(response);
      if (!finalBucket && uploaded.jwt !== undefined) {
        throw new CloudflareAccountApiError('Cloudflare returned an invalid asset upload identity sequence.');
      }
      if (finalBucket) {
        completionJwt = requireAssetUploadJwt(uploaded.jwt);
        receivedCompletionJwt = true;
      }
    }
    if (!receivedCompletionJwt) {
      throw new CloudflareAccountApiError('Cloudflare did not return the completed asset upload identity.');
    }
    return completionJwt;
  }

  private async promoteWorkerVersion(workerName: string, workerVersionId: string, sourceSha256: string): Promise<void> {
    const promoted = await this.call<{ id?: string; versions?: Array<{ percentage?: number; version_id?: string }> }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
      {
        method: 'POST',
        body: JSON.stringify({
          strategy: 'percentage',
          versions: [{ percentage: 100, version_id: workerVersionId }],
          annotations: { 'workers/message': `Ghostbuild approved revision ${sourceSha256.slice(0, 12)}` },
        }),
      },
    );
    requireExactDeploymentVersion(promoted.versions, workerVersionId);
    if (!promoted.id || !UUID_PATTERN.test(promoted.id)) {
      throw new CloudflareAccountApiError('Cloudflare did not read back the promoted Worker deployment.');
    }
    const readback = await this.call<{
      id?: string;
      versions?: Array<{ percentage?: number; version_id?: string }>;
    }>(`/workers/scripts/${encodeURIComponent(workerName)}/deployments/${encodeURIComponent(promoted.id)}`, {
      method: 'GET',
    });
    if (readback.id !== promoted.id) {
      throw new CloudflareAccountApiError('Cloudflare did not read back the promoted Worker deployment.');
    }
    requireExactDeploymentVersion(readback.versions, workerVersionId);
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
    controlPlaneSecret: string;
    runtimeVersion: string;
    databaseId: string;
    userId: string;
    connectionId: string;
    connectionGeneration: number;
    endpoint: string;
  }): Promise<{ workerVersionId: string; namespaceId: string }> {
    requireWorkerName(args.workerName);
    if (!/^[a-f0-9]{64}$/.test(args.runtimeVersion) || args.controlPlaneSecret.length < 32) {
      throw new CloudflareAccountApiError('The workspace runtime identity is invalid.');
    }
    if (!args.userId) {
      throw new CloudflareAccountApiError('Workspace runtime credentials are required.');
    }
    const metadata = {
      main_module: 'workspace-runtime.mjs',
      compatibility_date: '2026-07-27',
      compatibility_flags: ['nodejs_compat', 'experimental'],
      containers: [{ class_name: 'ProjectWorkspace' }],
      bindings: [
        { type: 'durable_object_namespace', name: 'PROJECT_WORKSPACE', class_name: 'ProjectWorkspace' },
        { type: 'durable_object_namespace', name: 'BuilderAgent', class_name: 'BuilderAgent' },
        { type: 'd1', name: 'DB', id: args.databaseId },
        { type: 'ai', name: 'AI' },
        { type: 'worker_loader', name: 'LOADER' },
        { type: 'secret_text', name: 'CONTROL_PLANE_SECRET', text: args.controlPlaneSecret },
        { type: 'plain_text', name: 'CLOUDFLARE_ACCOUNT_ID', text: this.accountId },
        { type: 'plain_text', name: 'GHOSTBUILD_USER_ID', text: args.userId },
        { type: 'plain_text', name: 'GHOSTBUILD_CONNECTION_ID', text: args.connectionId },
        {
          type: 'plain_text',
          name: 'GHOSTBUILD_CONNECTION_GENERATION',
          text: String(args.connectionGeneration),
        },
        { type: 'plain_text', name: 'GHOSTBUILD_USER_RUNTIME_ENDPOINT', text: args.endpoint },
        { type: 'plain_text', name: 'GHOSTBUILD_CONTROL_PLANE_ENDPOINT', text: GHOSTBUILD_CONTROL_PLANE_ENDPOINT },
        { type: 'plain_text', name: 'GHOSTBUILD_USER_RUNTIME', text: '1' },
        { type: 'plain_text', name: 'GHOSTBUILD_RUNTIME_VERSION', text: args.runtimeVersion },
        { type: 'plain_text', name: 'SANDBOX_TRANSPORT', text: 'rpc' },
      ],
      exports: {
        ProjectWorkspace: {
          type: 'durable-object',
          storage: 'sqlite',
          container: 'ProjectWorkspace',
        },
        BuilderAgent: {
          type: 'durable-object',
          storage: 'sqlite',
        },
      },
      observability: { enabled: true, logs: { enabled: true, head_sampling_rate: 0.6 } },
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
    const version = await parseCloudflareEnvelope<{ id?: string }>(
      await this.callRaw(`/workers/scripts/${encodeURIComponent(args.workerName)}/versions`, {
        method: 'POST',
        body: form,
      }),
    );
    if (!version.id || !UUID_PATTERN.test(version.id)) {
      throw new CloudflareAccountApiError('Cloudflare did not identify the workspace runtime version.');
    }
    await this.promoteWorkerVersion(args.workerName, version.id, args.runtimeVersion);
    const namespaces = await this.call<DurableObjectNamespaceReadback[]>(
      '/workers/durable_objects/namespaces?per_page=1000',
      { method: 'GET' },
    );
    const namespace = namespaces.find(
      (candidate) =>
        candidate.script === args.workerName &&
        candidate.class === 'ProjectWorkspace' &&
        candidate.use_sqlite === true &&
        candidate.id,
    );
    if (!namespace?.id) {
      throw new CloudflareAccountApiError('Cloudflare did not provision the Computer workspace namespace.');
    }
    return { workerVersionId: version.id, namespaceId: namespace.id };
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
    const applications = await this.callContainer<unknown>('/applications', {
      method: 'GET',
    });
    const existing = existingContainerApplication(applications, args.applicationName);
    if (existing && existing.durable_objects.namespace_id !== args.namespaceId) {
      throw new CloudflareAccountApiError(
        'The workspace container name is already attached to a different Durable Object namespace.',
      );
    }
    const configuration = {
      configuration: {
        image: args.image,
        instance_type: PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
        observability: { logs: { enabled: true } },
        wrangler_ssh: false,
      },
      max_instances: args.maxInstances ?? PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES,
      constraints: { tiers: [1, 2] },
      scheduling_policy: 'default',
      rollout_active_grace_period: 0,
    };
    const result = existing
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
    const state = await this.call<{ enabled?: boolean; previews_enabled?: boolean }>(
      `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
      {
        method: 'POST',
        body: JSON.stringify({ enabled: true, previews_enabled: false }),
      },
    );
    if (state.enabled !== true || state.previews_enabled !== false) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker subdomain state.');
    }
    await this.readExactWorkerSubdomainState(workerName);
  }

  /** Replace every trigger with Ghostbuild's single deterministic runtime-GC schedule. */
  async configureWorkspaceRuntimeGcSchedule(workerName: string): Promise<void> {
    requireWorkerName(workerName);
    const result = await this.call<unknown>(`/workers/scripts/${encodeURIComponent(workerName)}/schedules`, {
      method: 'PUT',
      body: JSON.stringify([{ cron: USER_WORKSPACE_RUNTIME_GC_CRON }]),
    });
    if (!isRecord(result) || !Array.isArray(result.schedules) || result.schedules.length !== 1) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid workspace runtime schedules.');
    }
    const schedule = result.schedules[0];
    if (
      !isRecord(schedule) ||
      schedule.cron !== USER_WORKSPACE_RUNTIME_GC_CRON ||
      (schedule.created_on !== undefined && typeof schedule.created_on !== 'string') ||
      (schedule.modified_on !== undefined && typeof schedule.modified_on !== 'string')
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid workspace runtime schedules.');
    }
  }

  /** Reads the exact version currently receiving 100% of production traffic. */
  async readActiveWorkerDeployment(workerName: string): Promise<ActiveWorkerDeploymentReadback | null> {
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(workerName)) {
      throw new CloudflareAccountApiError('Worker name is invalid.');
    }
    const listed = await this.callOptional<unknown>(`/workers/scripts/${encodeURIComponent(workerName)}/deployments`, {
      method: 'GET',
    });
    if (listed === null) {
      return null;
    }
    const active = requireWorkerDeployments(listed).sort((left, right) =>
      right.created_on.localeCompare(left.created_on),
    )[0];
    const activeVersions = active?.versions.filter((version) => version.percentage === 100) ?? [];
    if (!active?.id || activeVersions.length !== 1 || !activeVersions[0]?.version_id) {
      throw new CloudflareAccountApiError('Cloudflare returned an ambiguous active Worker deployment.');
    }
    const workerVersionId = activeVersions[0].version_id;
    const [version, schedules] = await Promise.all([
      this.call<{
        id?: string;
        resources?: {
          bindings?: WorkerBinding[];
          script?: { etag?: string };
          script_runtime?: { compatibility_date?: string; compatibility_flags?: string[] };
        };
      }>(`/workers/scripts/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(workerVersionId)}`, {
        method: 'GET',
      }),
      this.call<unknown>(`/workers/scripts/${encodeURIComponent(workerName)}/schedules`, { method: 'GET' }),
    ]);
    if (
      version.id !== workerVersionId ||
      !Array.isArray(version.resources?.bindings) ||
      typeof version.resources.script?.etag !== 'string' ||
      version.resources.script.etag.length < 1 ||
      version.resources.script.etag.length > 256 ||
      typeof version.resources.script_runtime?.compatibility_date !== 'string' ||
      !Array.isArray(version.resources.script_runtime.compatibility_flags) ||
      version.resources.script_runtime.compatibility_flags.some((flag) => typeof flag !== 'string')
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid active Worker version metadata.');
    }
    const bindings = requireWorkerBindings(version.resources.bindings);
    const crons = requireSchedules(schedules);
    return {
      providerDeploymentId: active.id,
      workerVersionId,
      scriptEtag: version.resources.script.etag,
      bindings,
      crons,
      compatibilityDate: version.resources.script_runtime.compatibility_date,
      compatibilityFlags: version.resources.script_runtime.compatibility_flags,
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
    const payload = await readBoundedJson<CloudflareEnvelope<T>>(response);
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
    let response = await this.executeRaw(path, init, this.accessToken);
    if (response.status === 401 && this.refreshAccessToken) {
      await response.body?.cancel().catch(() => undefined);
      const refreshed = await this.refreshAccessToken();
      if (!refreshed || refreshed.length > 4_096) {
        throw new CloudflareAccountApiError('Cloudflare connection is unavailable.');
      }
      this.accessToken = refreshed;
      await this.authorizeRequest?.();
      response = await this.executeRaw(path, init, refreshed);
    }
    return response;
  }

  private async executeRaw(path: string, init: RequestInit, bearer: string): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new CloudflareAccountApiError('Cloudflare API path is invalid.');
    }
    const execute = this.request;
    const response = await execute(`${API_ROOT}/accounts/${encodeURIComponent(this.accountId)}${path}`, {
      ...init,
      redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(CLOUDFLARE_API_TIMEOUT_MS),
      headers: {
        ...init.headers,
        authorization: `Bearer ${bearer}`,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new CloudflareAccountApiError('Cloudflare API request redirected unexpectedly.');
    }
    return response;
  }

  private async callContainer<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.callRaw(`/containers${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    const payload = await readBoundedJson<CloudflareEnvelope<T> | T | { error?: string; message?: string }>(response);
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

class AssetUploadSessionExpiredError extends Error {}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseCloudflareEnvelope<T>(response: Response): Promise<T> {
  const payload = await readBoundedJson<CloudflareEnvelope<T>>(response);
  if (!response.ok || payload?.success !== true || payload.result === undefined) {
    throw new CloudflareAccountApiError(
      payload?.errors?.find((error) => error.message)?.message || `Cloudflare API request failed (${response.status}).`,
    );
  }
  return payload.result;
}

async function readBoundedJson<T>(response: Response): Promise<T | null> {
  const contentLength = Number(response.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_CLOUDFLARE_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const text = await readBoundedResponseText(response, MAX_CLOUDFLARE_RESPONSE_BYTES);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function readBoundedResponseText(response: Response, limit: number): Promise<string | null> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function requireAssetUploadJwt(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ASSET_UPLOAD_JWT_BYTES) {
    throw new CloudflareAccountApiError('Cloudflare returned an invalid asset upload identity.');
  }
  return value;
}

function requireExactDeploymentVersion(
  versions: Array<{ percentage?: number; version_id?: string }> | undefined,
  expectedVersionId: string,
): void {
  if (versions?.length !== 1 || versions[0]?.percentage !== 100 || versions[0]?.version_id !== expectedVersionId) {
    throw new CloudflareAccountApiError('Cloudflare returned an ambiguous Worker deployment.');
  }
}

function requireExactSchedules(result: unknown, expected: readonly string[]): void {
  const observed = requireSchedules(result);
  if (observed.length !== expected.length || observed.some((cron, index) => cron !== expected[index])) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker schedules.');
  }
}

function requireSchedules(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.schedules)) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker schedules.');
  }
  return value.schedules.map((schedule) => {
    if (!isRecord(schedule) || typeof schedule.cron !== 'string' || schedule.cron.length === 0) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid managed Worker schedules.');
    }
    return schedule.cron;
  });
}

function existingD1DatabaseId(value: unknown, resourceName: string): string | null {
  if (!Array.isArray(value)) {
    throw new CloudflareAccountApiError('Cloudflare returned an invalid D1 resource list.');
  }
  const databases = value.map((database) => {
    if (
      !isRecord(database) ||
      typeof database.name !== 'string' ||
      database.name.length === 0 ||
      typeof database.uuid !== 'string' ||
      database.uuid.length === 0 ||
      database.uuid.length > 256
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned an invalid D1 resource.');
    }
    return { name: database.name, uuid: database.uuid };
  });
  const matches = databases.filter((database) => database.name === resourceName);
  if (matches.length > 1) {
    throw new CloudflareAccountApiError('Cloudflare returned an ambiguous D1 resource list.');
  }
  const existing = matches[0];
  if (!existing) {
    return null;
  }
  return existing.uuid;
}

function requireWorkerDeployments(value: unknown): Array<{
  id: string;
  created_on: string;
  versions: Array<{ percentage: number; version_id: string }>;
}> {
  if (!isRecord(value) || !Array.isArray(value.deployments)) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid Worker deployments.');
  }
  return value.deployments.map((deployment) => {
    if (
      !isRecord(deployment) ||
      typeof deployment.id !== 'string' ||
      deployment.id.length === 0 ||
      typeof deployment.created_on !== 'string' ||
      deployment.created_on.length === 0 ||
      !Array.isArray(deployment.versions)
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid Worker deployments.');
    }
    const versions = deployment.versions.map((version) => {
      if (
        !isRecord(version) ||
        typeof version.percentage !== 'number' ||
        !Number.isFinite(version.percentage) ||
        typeof version.version_id !== 'string' ||
        version.version_id.length === 0
      ) {
        throw new CloudflareAccountApiError('Cloudflare returned invalid Worker deployments.');
      }
      return { percentage: version.percentage, version_id: version.version_id };
    });
    return { id: deployment.id, created_on: deployment.created_on, versions };
  });
}

function requireWorkerBindings(value: unknown[]): WorkerBinding[] {
  return value.map((binding) => {
    if (
      !isRecord(binding) ||
      typeof binding.name !== 'string' ||
      binding.name.length === 0 ||
      typeof binding.type !== 'string' ||
      binding.type.length === 0
    ) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid active Worker bindings.');
    }
    return binding;
  });
}

function existingContainerApplication(
  value: unknown,
  applicationName: string,
): Required<Pick<ContainerApplicationReadback, 'id' | 'name' | 'durable_objects'>> | null {
  if (!Array.isArray(value)) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container applications.');
  }
  const applications = value.map((application) => {
    if (!isRecord(application) || typeof application.name !== 'string' || application.name.length === 0) {
      throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container applications.');
    }
    return application;
  });
  const matches = applications.filter((application) => application.name === applicationName);
  if (matches.length > 1) {
    throw new CloudflareAccountApiError('Cloudflare returned ambiguous workspace container applications.');
  }
  const existing = matches[0];
  if (!existing) {
    return null;
  }
  if (
    typeof existing.id !== 'string' ||
    existing.id.length === 0 ||
    !isRecord(existing.durable_objects) ||
    typeof existing.durable_objects.namespace_id !== 'string' ||
    existing.durable_objects.namespace_id.length === 0
  ) {
    throw new CloudflareAccountApiError('Cloudflare returned invalid workspace container application.');
  }
  return {
    id: existing.id,
    name: applicationName,
    durable_objects: { namespace_id: existing.durable_objects.namespace_id },
  };
}

function workerModuleContentType(path: string): string {
  return path.endsWith('.wasm') ? 'application/wasm' : 'application/javascript+module';
}

function staticAssetContentType(path: string): string {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return (
    (
      {
        css: 'text/css',
        gif: 'image/gif',
        html: 'text/html',
        ico: 'image/x-icon',
        jpeg: 'image/jpeg',
        jpg: 'image/jpeg',
        js: 'text/javascript',
        json: 'application/json',
        map: 'application/json',
        mjs: 'text/javascript',
        png: 'image/png',
        svg: 'image/svg+xml',
        txt: 'text/plain',
        wasm: 'application/wasm',
        webmanifest: 'application/manifest+json',
        webp: 'image/webp',
        woff: 'font/woff',
        woff2: 'font/woff2',
        xml: 'application/xml',
      } as Record<string, string>
    )[extension] ?? 'application/octet-stream'
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  }
  return btoa(binary);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
