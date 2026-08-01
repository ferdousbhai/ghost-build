import { Sandbox, type DirectoryBackup } from '@cloudflare/sandbox';
import { BuilderWorkspaceRepository, type BuilderWorkspaceBackend } from '../../app/agents/builder-workspace';
import { addRequestedDependencies } from '../../app/lib/runtime/action-runner/dependency-manifest';
import { toolFailure, toolSuccess, type GhostbuildToolResult } from '../../ghostbuild-agent/tool-result';
import { parse } from 'jsonc-parser';
import { initializeWorkspaceRuntimeSchema } from '../../app/agents/builder-workspace-runtime-schema';

interface RuntimeEnv {
  WORKSPACE_SANDBOX: DurableObjectNamespace<WorkspaceSandbox>;
  BACKUP_BUCKET: R2Bucket;
  CONTROL_PLANE_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  BACKUP_BUCKET_NAME: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,256}$/;
const CHECKPOINT_EXCLUDED_ROOTS = new Set(['node_modules', 'dist', '.output', '.tanstack', '.wrangler']);
const PREVIEW_PORT = 4173;
const PREVIEW_TTL_MS = 15 * 60_000;

export class WorkspaceSandbox extends Sandbox<RuntimeEnv> {
  readonly #workspace: BuilderWorkspaceRepository;

  constructor(ctx: DurableObjectState<{}>, env: RuntimeEnv) {
    super(ctx, env);
    initializeWorkspaceRuntimeSchema(ctx.storage);
    const backend: BuilderWorkspaceBackend = {
      sandbox: this as unknown as BuilderWorkspaceBackend['sandbox'],
      backupBucket: env.BACKUP_BUCKET,
      localBackup: false,
      installDependencies: async (sandbox, projectDir) => {
        const pnpm = await sandbox.exec('command -v pnpm', { timeout: 30_000 });
        requireExecSuccess(pnpm);
        const installed = await sandbox.exec(
          `${shellQuote(pnpm.stdout.trim())} install --frozen-lockfile --ignore-scripts=true --ignore-pnpmfile ` +
            '--registry=https://registry.npmjs.org/',
          { cwd: projectDir, timeout: 4 * 60_000 },
        );
        requireExecSuccess(installed);
      },
      retireBackup: async (backup, notBefore) => {
        ctx.storage.sql.exec(
          `INSERT INTO retired_backups (backup_id, delete_after) VALUES (?, ?)
           ON CONFLICT(backup_id) DO UPDATE SET delete_after = MAX(delete_after, excluded.delete_after)`,
          backup.id,
          notBefore,
        );
      },
    };
    this.#workspace = new BuilderWorkspaceRepository(ctx.storage, backend, ctx.id.toString());
  }

  getWorkspaceState() {
    return this.#workspace.getState();
  }

  beginSeed(seedId: unknown) {
    return this.#workspace.beginSeed(seedId);
  }

  appendSeed(seedId: unknown, entries: unknown) {
    return this.#workspace.appendSeed(seedId, entries);
  }

  commitSeed(seedId: unknown, expected: unknown) {
    return this.#workspace.commitSeed(seedId, expected);
  }

  abortSeed(seedId: unknown) {
    return this.#workspace.abortSeed(seedId);
  }

  applyChanges(request: unknown) {
    return this.#workspace.applyClientChanges(request);
  }

  getSyncPage(request: unknown) {
    return this.#workspace.getSyncPage(request);
  }

  readText(path: unknown) {
    return this.#workspace.readText(path);
  }

  readWorkspaceFile(path: unknown) {
    return this.#workspace.readFile(path);
  }

  listWorkspaceFiles() {
    return this.#workspace.listFiles();
  }

  async checkpoint() {
    await this.#workspace.ensureRuntimeReady();
    const state = this.#workspace.getState();
    if (!state.initialized) {
      throw new Error('The project workspace is not initialized.');
    }
    const files = this.#workspace
      .listFiles()
      .map((file) => ({ ...file, relativePath: relativeProjectPath(file.path) }))
      .filter((file) => !CHECKPOINT_EXCLUDED_ROOTS.has(file.relativePath.split('/')[0] ?? ''))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const revision = await sha256(JSON.stringify(files.map((file) => [file.relativePath, file.sha256])));
    const current = this.#workspace.getState();
    if (current.revision !== state.revision) {
      throw new Error('The project workspace changed while its checkpoint was created.');
    }
    return { workspaceRevision: state.revision, revision };
  }

  async checkpointWithBackup() {
    const checkpoint = await this.checkpoint();
    return { ...checkpoint, backup: this.#workspace.getBackupHandle() };
  }

  async installDependenciesTool(value: unknown): Promise<GhostbuildToolResult> {
    const input = record(value);
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    const mode = input.mode === 'sync-lockfile' ? 'sync-lockfile' : input.mode === 'add' ? 'add' : null;
    const packages = requireStringArray(input.packages, 'packages', 100);
    if (!mode) {
      throw new SyntaxError('Invalid dependency installation mode.');
    }
    const checkpoint = await this.checkpointWithBackup();
    const packageFile = await this.#workspace.readText('/home/project/package.json');
    const packageJson =
      mode === 'sync-lockfile' ? packageFile.content : addRequestedDependencies(packageFile.content, packages);
    const operation = this.env.WORKSPACE_SANDBOX.get(
      this.env.WORKSPACE_SANDBOX.idFromName(`dependencies:${this.ctx.id.toString()}:${toolCallId}`),
    ) as unknown as WorkspaceSandbox;
    const startedAt = Date.now();
    return this.#workspace.commitTextFilesTool({
      toolCallId,
      toolName: 'npmInstall',
      toolArgs: input.input,
      expectedWorkspaceRevision: checkpoint.workspaceRevision,
      prepare: () => operation.prepareDependencyFiles(checkpoint.backup, packageJson),
      result: ({ changedPaths, workspaceRevision }) =>
        toolSuccess(
          mode === 'sync-lockfile'
            ? 'Synchronized the durable project lockfile with package.json in the user-owned Sandbox.'
            : `Installed ${packages.length} dependency package${packages.length === 1 ? '' : 's'} in the durable project.`,
          {
            mode,
            changedPaths,
            workspaceRevision,
            buildEnvironment: 'user-cloudflare-sandbox',
            durationMs: Date.now() - startedAt,
          },
        ),
    });
  }

  async prepareDependencyFiles(backup: DirectoryBackup, packageJson: string) {
    await this.killAllProcesses();
    const restored = await this.restoreBackup({ ...backup, dir: '/home/project' });
    if (!restored.success) {
      throw new Error('The project backup could not be restored for dependency installation.');
    }
    await this.writeFile('/home/project/package.json', packageJson);
    const pnpm = await this.exec('command -v pnpm', { timeout: 30_000 });
    requireExecSuccess(pnpm);
    requireExecSuccess(
      await this.exec(
        `${shellQuote(pnpm.stdout.trim())} install --lockfile-only --ignore-scripts=true --ignore-pnpmfile ` +
          '--registry=https://registry.npmjs.org/',
        { cwd: '/home/project', timeout: 4 * 60_000 },
      ),
    );
    const [nextPackageJson, pnpmLock] = await Promise.all([
      this.readFile('/home/project/package.json', { encoding: 'utf8' }),
      this.readFile('/home/project/pnpm-lock.yaml', { encoding: 'utf8' }),
    ]);
    return [
      { path: '/home/project/package.json', content: nextPackageJson.content },
      { path: '/home/project/pnpm-lock.yaml', content: pnpmLock.content },
    ];
  }

  async validateTool(value: unknown): Promise<GhostbuildToolResult> {
    const input = record(value);
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    const checkpoint = await this.checkpointWithBackup();
    return this.#workspace.executeToolOnce(toolCallId, 'validateProject', input.input, async () => {
      const operation = this.env.WORKSPACE_SANDBOX.get(
        this.env.WORKSPACE_SANDBOX.idFromName(`validation:${this.ctx.id.toString()}:${checkpoint.revision}`),
      ) as unknown as WorkspaceSandbox;
      const startedAt = Date.now();
      try {
        await operation.validateBackup(checkpoint.backup);
        const current = this.#workspace.getState();
        if (current.revision !== checkpoint.workspaceRevision) {
          return toolFailure('The durable project changed while validation was running. Validate the new revision.', {
            level: 'full',
            revision: checkpoint.revision,
            workspaceRevision: checkpoint.workspaceRevision,
            currentWorkspaceRevision: current.revision,
            buildEnvironment: 'user-cloudflare-sandbox',
          });
        }
        this.#workspace.recordSuccessfulValidation(checkpoint);
        return toolSuccess(`Project validation passed at durable workspace revision ${checkpoint.revision}.`, {
          level: 'full',
          revision: checkpoint.revision,
          workspaceRevision: checkpoint.workspaceRevision,
          buildEnvironment: 'user-cloudflare-sandbox',
          checks: [
            'workspace-policy',
            'dependency-installation',
            'typecheck',
            'stack-verification',
            'build',
            'lint',
          ].map((name) => ({ name, status: 'passed' as const })),
          durationMs: Date.now() - startedAt,
          nextAction: 'prepare-deployment',
        });
      } catch (error) {
        return toolFailure(error instanceof Error ? error.message.slice(-4_000) : 'User-owned validation failed.', {
          level: 'full',
          revision: checkpoint.revision,
          workspaceRevision: checkpoint.workspaceRevision,
          currentWorkspaceRevision: this.#workspace.getState().revision,
          buildEnvironment: 'user-cloudflare-sandbox',
          checks: [{ name: 'production-build', status: 'failed' as const }],
        });
      }
    });
  }

  async validateBackup(backup: DirectoryBackup): Promise<void> {
    await this.killAllProcesses();
    const restored = await this.restoreBackup({ ...backup, dir: '/home/project' });
    if (!restored.success) {
      throw new Error('The exact project backup could not be restored for validation.');
    }
    const commands = ['pnpm run typecheck', 'pnpm run verify:stack', 'pnpm run build', 'pnpm run lint'];
    for (const command of commands) {
      requireExecSuccess(await this.exec(command, { cwd: '/home/project', timeout: 5 * 60_000 }));
    }
  }

  validationStatus(revision: unknown) {
    return { valid: typeof revision === 'string' && this.#workspace.hasSuccessfulValidation(revision) };
  }

  async deploymentPlan(revision: unknown) {
    if (typeof revision !== 'string' || !this.#workspace.hasSuccessfulValidation(revision)) {
      throw new Error('Deployment requires successful validation of this exact revision.');
    }
    const checkpoint = await this.checkpoint();
    if (checkpoint.revision !== revision) {
      throw new Error('The durable project changed after validation. Run full validation again.');
    }
    const [packageFile, wranglerFile] = await Promise.all([
      this.#workspace.readText('/home/project/package.json'),
      this.#workspace.readText('/home/project/wrangler.jsonc'),
    ]);
    const packageJson = JSON.parse(packageFile.content) as { ghostbuild?: { projectType?: unknown } };
    const configuredType = packageJson.ghostbuild?.projectType;
    if (configuredType !== undefined && configuredType !== 'web_app' && configuredType !== 'worker') {
      throw new Error('The generated project type is invalid.');
    }
    const wrangler = parse(wranglerFile.content) as Record<string, unknown> | undefined;
    if (!wrangler || wrangler.main !== 'src/server.ts') {
      throw new Error('The generated Worker entrypoint is invalid.');
    }
    const hasArrayBinding = (value: unknown, binding: string) =>
      Array.isArray(value) && value.some((entry) => recordOrNull(entry)?.binding === binding);
    const bindings = {
      ai: recordOrNull(wrangler.ai)?.binding === 'AI',
      d1: hasArrayBinding(wrangler.d1_databases, 'DB'),
      r2: hasArrayBinding(wrangler.r2_buckets, 'APP_STORAGE'),
      appAgent:
        Array.isArray(recordOrNull(wrangler.durable_objects)?.bindings) &&
        (recordOrNull(wrangler.durable_objects)?.bindings as unknown[]).some(
          (entry) => recordOrNull(entry)?.name === 'AppAgent',
        ),
    };
    return {
      ...checkpoint,
      project: { type: configuredType === 'worker' ? ('worker' as const) : ('web_app' as const), bindings },
    };
  }

  async createPreview(value: unknown) {
    const input = record(value);
    const previewId = requireString(input.previewId, 'previewId', 128);
    const checkpoint = await this.checkpointWithBackup();
    const preview = this.env.WORKSPACE_SANDBOX.get(
      this.env.WORKSPACE_SANDBOX.idFromName(`preview:${this.ctx.id.toString()}:${previewId}`),
    ) as unknown as WorkspaceSandbox;
    const url = await preview.startPreview(checkpoint.backup, previewId);
    const now = Date.now();
    return {
      id: previewId,
      url,
      workspaceRevision: checkpoint.workspaceRevision,
      snapshotRevision: checkpoint.revision,
      readyAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    };
  }

  async startPreview(backup: DirectoryBackup, previewId: string): Promise<string> {
    await this.killAllProcesses();
    const restored = await this.restoreBackup({ ...backup, dir: '/home/project' });
    if (!restored.success) {
      throw new Error('The exact project backup could not be restored for preview.');
    }
    for (const command of ['pnpm exec vite build --config vite.preview.config.mjs']) {
      requireExecSuccess(await this.exec(command, { cwd: '/home/project', timeout: 5 * 60_000 }));
    }
    const process = await this.startProcess(
      `pnpm exec vite preview --config vite.preview.config.mjs --host 0.0.0.0 --port ${PREVIEW_PORT} --strictPort`,
      {
        cwd: '/home/project',
        timeout: PREVIEW_TTL_MS,
        autoCleanup: false,
        processId: 'ghostbuild-preview',
      },
    );
    await process.waitForPort(PREVIEW_PORT, { mode: 'http', status: { min: 200, max: 399 }, timeout: 45_000 });
    await this.setKeepAlive(true);
    const tunnel = await this.tunnels.get(PREVIEW_PORT, { name: `preview-${previewId.slice(0, 32)}` });
    await this.schedule(PREVIEW_TTL_MS / 1_000, 'expirePreview', { previewId });
    return tunnel.url;
  }

  async stopPreview(previewId: unknown) {
    const id = requireString(previewId, 'previewId', 128);
    this.deleteSchedules('expirePreview');
    await this.expirePreview({ previewId: id });
    await this.destroy();
  }

  async expirePreview(value: unknown): Promise<void> {
    requireString(record(value).previewId, 'previewId', 128);
    await this.tunnels.destroy(PREVIEW_PORT).catch(() => undefined);
    await this.killAllProcesses().catch(() => undefined);
    await this.setKeepAlive(false);
  }

  async deploy(value: unknown) {
    const input = record(value);
    const revision = requireString(input.revision, 'revision', 64);
    if (!/^[a-f0-9]{64}$/.test(revision) || !this.#workspace.hasSuccessfulValidation(revision)) {
      throw new Error('Deployment requires successful validation of this exact revision.');
    }
    const checkpoint = await this.checkpointWithBackup();
    if (checkpoint.revision !== revision) {
      throw new Error('The durable project changed after validation. Run full validation again.');
    }
    const deploymentId = requireString(input.deploymentId, 'deploymentId', 128);
    const operation = this.env.WORKSPACE_SANDBOX.get(
      this.env.WORKSPACE_SANDBOX.idFromName(`deployment:${this.ctx.id.toString()}:${deploymentId}`),
    ) as unknown as WorkspaceSandbox;
    return operation.deployBackup(checkpoint.backup, input);
  }

  async deployBackup(backup: DirectoryBackup, value: Record<string, unknown>) {
    const apiToken = requireString(value.apiToken, 'apiToken', 4096);
    const accountId = requireString(value.accountId, 'accountId', 64);
    const workerName = requireCloudflareName(value.workerName, 'workerName');
    const projectType = value.projectType === 'worker' ? 'worker' : value.projectType === 'web_app' ? 'web_app' : null;
    if (!projectType) {
      throw new SyntaxError('Invalid deployment project type.');
    }
    const restored = await this.restoreBackup({ ...backup, dir: '/home/project' });
    if (!restored.success) {
      throw new Error('The exact validated backup could not be restored for deployment.');
    }
    for (const command of ['pnpm run typecheck', 'pnpm run verify:stack', 'pnpm run build', 'pnpm run lint']) {
      requireExecSuccess(await this.exec(command, { cwd: '/home/project', timeout: 5 * 60_000 }));
    }
    const config = trustedDeploymentConfig({ ...value, accountId, workerName, projectType });
    const configPath = '/home/project/.ghostbuild-deploy.json';
    const outputPath = '/tmp/ghostbuild-wrangler-output.ndjson';
    await this.writeFile(configPath, JSON.stringify(config));
    const commandEnv = {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: apiToken,
      WRANGLER_OUTPUT_FILE_PATH: outputPath,
    };
    if (typeof value.d1DatabaseId === 'string') {
      requireExecSuccess(
        await this.exec(`pnpm exec wrangler d1 migrations apply DB --remote --config ${configPath} --yes`, {
          cwd: '/home/project',
          env: commandEnv,
          timeout: 5 * 60_000,
        }),
      );
    }
    if (typeof value.agentSecurityD1DatabaseId === 'string') {
      requireExecSuccess(
        await this.exec(
          `pnpm exec wrangler d1 migrations apply AGENT_SECURITY_DB --remote --config ${configPath} --yes`,
          { cwd: '/home/project', env: commandEnv, timeout: 5 * 60_000 },
        ),
      );
    }
    requireExecSuccess(
      await this.exec(`pnpm exec wrangler deploy --config ${configPath}`, {
        cwd: '/home/project',
        env: commandEnv,
        timeout: 10 * 60_000,
      }),
    );
    const output = await this.readFile(outputPath, { encoding: 'utf8' });
    return { workerName, workerVersionId: parseWranglerVersion(output.content, workerName) };
  }

  async cleanupRetiredBackups(now = Date.now()): Promise<number> {
    const due = [
      ...this.ctx.storage.sql.exec<{ backup_id: string }>(
        `SELECT backup_id FROM retired_backups WHERE delete_after <= ? ORDER BY delete_after LIMIT 100`,
        now,
      ),
    ];
    for (const row of due) {
      await this.env.BACKUP_BUCKET.delete([`backups/${row.backup_id}/data.sqsh`, `backups/${row.backup_id}/meta.json`]);
      this.ctx.storage.sql.exec('DELETE FROM retired_backups WHERE backup_id = ?', row.backup_id);
    }
    return due.length;
  }

  async deleteProject(): Promise<void> {
    const retired = [...this.ctx.storage.sql.exec<{ backup_id: string }>('SELECT backup_id FROM retired_backups')];
    for (const row of retired) {
      await this.env.BACKUP_BUCKET.delete([`backups/${row.backup_id}/data.sqsh`, `backups/${row.backup_id}/meta.json`]);
    }
    this.ctx.storage.sql.exec('DELETE FROM retired_backups');
    await this.#workspace.deleteExternalObjects();
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    if (!authorized(request, env.CONTROL_PLANE_SECRET)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/health') {
      return Response.json({ ok: true, service: 'ghostbuild-user-workspace-runtime', version: 1 });
    }
    const route = parseProjectRoute(url.pathname);
    if (!route) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const id = env.WORKSPACE_SANDBOX.idFromName(route.projectId);
    const project = env.WORKSPACE_SANDBOX.get(id) as unknown as WorkspaceSandbox;
    try {
      await project.cleanupRetiredBackups().catch(() => 0);
      if (request.method === 'GET' && route.operation === 'state') {
        return Response.json(await project.getWorkspaceState());
      }
      if (request.method === 'POST' && route.operation === 'seed/begin') {
        const body = await readJson(request);
        return Response.json(await project.beginSeed(record(body).seedId));
      }
      if (request.method === 'POST' && route.operation === 'seed/append') {
        const body = record(await readJson(request));
        return Response.json(await project.appendSeed(body.seedId, body.entries));
      }
      if (request.method === 'POST' && route.operation === 'seed/commit') {
        const body = record(await readJson(request));
        return Response.json(await project.commitSeed(body.seedId, body.expected));
      }
      if (request.method === 'POST' && route.operation === 'seed/abort') {
        const body = record(await readJson(request));
        return Response.json(await project.abortSeed(body.seedId));
      }
      if (request.method === 'POST' && route.operation === 'changes') {
        return Response.json(await project.applyChanges(await readJson(request)));
      }
      if (request.method === 'POST' && route.operation === 'sync') {
        return Response.json(await project.getSyncPage(await readJson(request)));
      }
      if (request.method === 'POST' && route.operation === 'read-text') {
        return Response.json(await project.readText(record(await readJson(request)).path));
      }
      if (request.method === 'POST' && route.operation === 'read-file') {
        const file = await project.readWorkspaceFile(record(await readJson(request)).path);
        return Response.json({ ...file, bytes: encodeBase64(file.bytes) });
      }
      if (request.method === 'GET' && route.operation === 'files') {
        return Response.json(await project.listWorkspaceFiles());
      }
      if (request.method === 'POST' && route.operation === 'checkpoint') {
        return Response.json(await project.checkpoint());
      }
      if (request.method === 'POST' && route.operation === 'dependencies') {
        return Response.json(await project.installDependenciesTool(await readJson(request)));
      }
      if (request.method === 'POST' && route.operation === 'validate') {
        return Response.json(await project.validateTool(await readJson(request)));
      }
      if (request.method === 'POST' && route.operation === 'validation-status') {
        return Response.json(await project.validationStatus(record(await readJson(request)).revision));
      }
      if (request.method === 'POST' && route.operation === 'deployment-plan') {
        return Response.json(await project.deploymentPlan(record(await readJson(request)).revision));
      }
      if (request.method === 'POST' && route.operation === 'preview') {
        return Response.json(await project.createPreview(await readJson(request)));
      }
      if (request.method === 'POST' && route.operation === 'preview/stop') {
        const body = record(await readJson(request));
        const previewId = requireString(body.previewId, 'previewId', 128);
        const preview = env.WORKSPACE_SANDBOX.get(
          env.WORKSPACE_SANDBOX.idFromName(`preview:${id.toString()}:${previewId}`),
        ) as unknown as WorkspaceSandbox;
        await preview.stopPreview(previewId);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'POST' && route.operation === 'deploy') {
        return Response.json(await project.deploy(await readJson(request)));
      }
      if (request.method === 'DELETE' && route.operation === '') {
        await project.deleteProject();
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message.slice(-4_000) : 'Workspace operation failed.' },
        { status: error instanceof SyntaxError ? 400 : 409 },
      );
    }
  },
};

function parseProjectRoute(pathname: string): { projectId: string; operation: string } | null {
  const match = /^\/v1\/projects\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!match) {
    return null;
  }
  let projectId: string;
  try {
    projectId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    return null;
  }
  return { projectId, operation: match[2] ?? '' };
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
    throw new SyntaxError('Workspace request is too large.');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new SyntaxError('Workspace request is too large.');
  }
  return JSON.parse(text);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyntaxError('Workspace request must be an object.');
  }
  return value as Record<string, unknown>;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return value;
}

function requireStringArray(value: unknown, name: string, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxLength || value.some((item) => typeof item !== 'string')) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return value as string[];
}

function requireCloudflareName(value: unknown, name: string): string {
  const result = requireString(value, name, 64);
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(result)) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return result;
}

function trustedDeploymentConfig(
  args: Record<string, unknown> & {
    accountId: string;
    workerName: string;
    projectType: 'web_app' | 'worker';
  },
) {
  const config: Record<string, unknown> = {
    name: args.workerName,
    account_id: args.accountId,
    main: args.projectType === 'worker' ? 'dist/worker/server.js' : 'dist/server/index.js',
    no_bundle: true,
    compatibility_date: '2026-07-21',
    compatibility_flags: ['nodejs_compat'],
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 0.6 },
      traces: { enabled: true, head_sampling_rate: 0.05 },
    },
    upload_source_maps: true,
    workers_dev: true,
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    vars: {
      GHOSTBUILD_DEPLOYMENT_SECURITY_BASELINE: requireString(
        args.securityBaselineVersion,
        'securityBaselineVersion',
        32,
      ),
      GHOSTBUILD_APP_AGENT_SECURITY_BOUNDARY_SHA256: requireString(
        args.securityBoundarySha256,
        'securityBoundarySha256',
        64,
      ),
      GHOSTBUILD_TEMPLATE_SOURCE_SHA256: requireString(args.templateSourceSha256, 'templateSourceSha256', 64),
    },
  };
  if (args.projectType === 'web_app') {
    config.assets = { directory: 'dist/client' };
  }
  if (args.workersAi === true) {
    config.ai = { binding: 'AI' };
  }
  const d1Databases: Record<string, string>[] = [];
  if (typeof args.d1DatabaseId === 'string') {
    d1Databases.push({
      binding: 'DB',
      database_name: requireCloudflareName(args.d1DatabaseName, 'd1DatabaseName'),
      database_id: requireString(args.d1DatabaseId, 'd1DatabaseId', 64),
      migrations_dir: 'migrations',
    });
  }
  if (typeof args.agentSecurityD1DatabaseId === 'string') {
    d1Databases.push({
      binding: 'AGENT_SECURITY_DB',
      database_name: requireCloudflareName(args.agentSecurityD1DatabaseName, 'agentSecurityD1DatabaseName'),
      database_id: requireString(args.agentSecurityD1DatabaseId, 'agentSecurityD1DatabaseId', 64),
      migrations_dir: 'agent-security-migrations',
    });
  }
  if (d1Databases.length > 0) {
    config.d1_databases = d1Databases;
  }
  if (typeof args.r2BucketName === 'string') {
    config.r2_buckets = [
      { binding: 'APP_STORAGE', bucket_name: requireCloudflareName(args.r2BucketName, 'r2BucketName') },
    ];
  }
  if (args.appAgent === true) {
    config.durable_objects = { bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] };
    config.exports = { AppAgent: { type: 'durable-object', storage: 'sqlite' } };
    config.triggers = { crons: ['17 3 * * *'] };
  }
  return config;
}

function parseWranglerVersion(content: string, workerName: string): string {
  if (new TextEncoder().encode(content).byteLength > 32 * 1024) {
    throw new Error('Wrangler structured output exceeds the size limit.');
  }
  const versions: string[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (
      entry.type === 'deploy' &&
      entry.version === 1 &&
      entry.worker_name === workerName &&
      typeof entry.version_id === 'string'
    ) {
      versions.push(entry.version_id);
    }
  }
  if (versions.length !== 1 || !/^[0-9a-f-]{32,64}$/i.test(versions[0]!)) {
    throw new Error('Wrangler did not identify exactly one published Worker version.');
  }
  return versions[0]!;
}

function relativeProjectPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.replace(/^\/?(?:home\/project|workspace\/project)\/?/, '').replace(/^\/+/, '');
}

function requireExecSuccess(result: { success: boolean; stdout: string; stderr: string }): void {
  if (!result.success) {
    throw new Error(`${result.stderr}\n${result.stdout}`.trim() || 'The project Sandbox command failed.');
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function authorized(request: Request, expected: string): boolean {
  const value = request.headers.get('authorization');
  if (!value?.startsWith('Bearer ') || expected.length < 32) {
    return false;
  }
  const supplied = value.slice('Bearer '.length);
  if (supplied.length !== expected.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}
