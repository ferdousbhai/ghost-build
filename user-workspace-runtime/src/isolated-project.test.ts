import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createContainerDirectoryCommand,
  createIsolatedProjectCommand,
  rebaseDeploymentConfigPaths,
  relativeIsolatedPath,
} from './isolated-project';

describe('isolated project command', () => {
  it('copies source without durable dependencies or build output', () => {
    const command = createIsolatedProjectCommand({
      projectRoot: '/home/project',
      isolatedRoot: '/tmp/ghostbuild-projects/validation-id',
      quote: (value) => `'${value}'`,
    });

    expect(command).toContain("tar -C '/home/project'");
    expect(command).toContain("--exclude='./node_modules'");
    expect(command).toContain("--exclude='./dist'");
    expect(command).toContain("--exclude='./.wrangler'");
    expect(command).not.toContain('ln -s');
    expect(command).toContain("'/tmp/ghostbuild-projects/validation-id'");
    expect(command).toContain("mkdir -p '/tmp/ghostbuild-projects/validation-id'");
    expect(command).toContain('Project source cannot contain non-regular files.');
  });

  it('rebases every trusted Wrangler project path into the isolated copy', () => {
    const config = rebaseDeploymentConfigPaths(
      {
        main: '/home/project/dist/server/index.js',
        assets: { directory: '/home/project/dist/client' },
        d1_databases: [
          { binding: 'DB', migrations_dir: '/home/project/migrations' },
          { binding: 'AGENT_SECURITY_DB', migrations_dir: '/home/project/agent-security-migrations' },
        ],
      },
      { projectRoot: '/home/project', isolatedRoot: '/tmp/ghostbuild-projects/deployment-id' },
    );

    expect(config).toEqual({
      main: '/tmp/ghostbuild-projects/deployment-id/dist/server/index.js',
      assets: { directory: '/tmp/ghostbuild-projects/deployment-id/dist/client' },
      d1_databases: [
        { binding: 'DB', migrations_dir: '/tmp/ghostbuild-projects/deployment-id/migrations' },
        {
          binding: 'AGENT_SECURITY_DB',
          migrations_dir: '/tmp/ghostbuild-projects/deployment-id/agent-security-migrations',
        },
      ],
    });
  });

  it('enters a quoted native directory from a valid workspace cwd', () => {
    expect(
      createContainerDirectoryCommand({
        directory: '/tmp/ghostbuild projects/validation-id',
        command: 'pnpm run build',
        quote: (value) => `'${value}'`,
      }),
    ).toBe("cd '/tmp/ghostbuild projects/validation-id' &&\npnpm run build");
  });

  it('rejects trusted deployment paths outside the durable project root', () => {
    expect(() =>
      rebaseDeploymentConfigPaths(
        { main: '/tmp/untrusted.js' },
        { projectRoot: '/home/project', isolatedRoot: '/tmp/ghostbuild-projects/deployment-id' },
      ),
    ).toThrow(/outside the project root/i);
  });

  it('derives artifact paths from the requested root, not transport metadata', () => {
    expect(
      relativeIsolatedPath(
        '/tmp/ghostbuild-projects/deployment-id/.ghostbuild-artifact',
        '/tmp/ghostbuild-projects/deployment-id/.ghostbuild-artifact/index.js',
      ),
    ).toBe('index.js');
    expect(() =>
      relativeIsolatedPath(
        '/tmp/ghostbuild-projects/deployment-id/.ghostbuild-artifact',
        '/tmp/ghostbuild-projects/deployment-id/elsewhere/index.js',
      ),
    ).toThrow(/outside its expected root/i);
  });

  it('runs validation, preview, and deployment builds outside the durable project', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const validation = source.slice(
      source.indexOf('async validateTool('),
      source.indexOf('async beginDeploymentSession('),
    );
    const preview = source.slice(source.indexOf('async createPreview('), source.indexOf('async stopPreview('));
    const deployment = source.slice(
      source.indexOf('async prepareDeploymentArtifact('),
      source.indexOf('async deleteProject('),
    );

    for (const operation of [validation, deployment]) {
      expect(operation).toContain('createIsolatedProjectCommand');
      expect(operation).toContain('pushDurableProjectToContainer');
      expect(operation).toContain('runTransientCommand');
      expect(operation).toContain('INSTALL_TIMEOUT_MS');
      expect(operation).not.toContain('workspace.runtime.exec');
      expect(operation).not.toContain('removeDerivedFiles');
    }
    expect(preview).toContain('this.preparePreviewSnapshot({');
    expect(preview).not.toContain('INSTALL_COMMAND');
    expect(preview).not.toContain('pnpm run build:isolated-preview');
    expect(source).toContain('const INSTALL_TIMEOUT_MS = 10 * 60_000;');
    expect(deployment).toContain('rebaseDeploymentConfigPaths');
    expect(deployment).toContain('collectSandboxFiles(this, artifactRoot');
    expect(deployment).toContain('collectSandboxMigrations(this, `${isolatedRoot}/migrations`)');
    expect(preview).toContain("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: '.trycloudflare.com,container'");
    expect(preview).toContain('const previewProcess = await this.sandboxProcesses.exec(');
    expect(preview).toContain('assertActive: () => this.requirePreviewNotCancelled(previewId)');
    expect(source).toContain("await this.#workspace.push('container-shell')");
    expect(source).toContain("const TRANSIENT_COMMAND_PROCESS_ROLE = 'transient-command'");
    expect(validation).toContain('async cancelValidation(');
    expect(validation).toContain('active.cancellation.cancel()');
    expect(validation).toContain(
      "input.toolCallId === undefined ? null : requireString(input.toolCallId, 'toolCallId', 512)",
    );
    expect(validation).toContain('toolCallId !== null && active.toolCallId !== toolCallId');
    expect(validation).toContain('this.#activeValidation.inputJson !== inputJson');
    expect(validation).toContain('cancellation.requireActive()');
    expect(validation).not.toContain('runValidationCommand');
    expect(validation).toContain('INSTALL_TIMEOUT_MS, cancellation');
    expect(validation).toContain('PREVIEW_PREPARATION_COMMANDS');
    expect(validation).toContain('ghostbuild_prepared_validation');
    expect(deployment).toContain("await this.runTransientCommand(isolatedRoot, 'pnpm run build', 5 * 60_000)");
    expect(deployment).not.toContain('pnpm run typecheck');
    expect(deployment).not.toContain('pnpm run verify:stack');
    expect(deployment).not.toContain('pnpm run lint');
    const initialCheckpoint = validation.indexOf('const before = await this.checkpoint()');
    const durablePush = validation.indexOf('await this.pushDurableProjectToContainer()');
    expect(validation.indexOf('cancellation.requireActive()', initialCheckpoint)).toBeLessThan(durablePush);
    const transientCommand = source.slice(
      source.indexOf('private async runTransientCommand('),
      source.indexOf('private async cleanupPreviewProcess('),
    );
    expect(transientCommand).toContain('this.setProcessForRole(TRANSIENT_COMMAND_PROCESS_ROLE, startedProcess.id)');
    expect(transientCommand).not.toContain('crypto.randomUUID()');
    expect(source).toContain("(kind) => kind === 'validate' || kind === 'preview'");
    expect(source).not.toContain("cwd: '/tmp'");
    expect(source).not.toContain('cwd: isolatedRoot');
    expect(source).not.toContain('cwd: snapshotRoot');

    const previewCleanup = source.slice(
      source.indexOf('private async cleanupPreviewProcess('),
      source.indexOf('private async cleanupPendingPreviews('),
    );
    expect(previewCleanup).toContain("await this.runTransientCommand('/', `rm -rf");
    expect(previewCleanup).not.toContain('this.runTransientCommand(PROJECT_ROOT');

    const materialization = source.slice(
      source.indexOf('private async pushDurableProjectToContainer('),
      source.indexOf('private async runTransientCommand('),
    );
    expect(materialization.match(/await this\.#workspace\.push\('container-shell'\)/g)).toHaveLength(2);
    expect(materialization).toContain('if ((await this.exists(PROJECT_ROOT)).exists)');
    expect(materialization).toContain('await this.#workspace.close()');
    expect(materialization).toContain('await this.restartComputerd(COMPUTERD_ENV)');
    expect(materialization).toContain('if (!(await this.exists(PROJECT_ROOT)).exists)');
  });

  it('reuses the validated snapshot for Preview and rebuilds only after container loss', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const prepare = source.slice(
      source.indexOf('private async preparePreviewSnapshot('),
      source.indexOf('private async discardPreparedValidationSnapshot('),
    );
    const reusable = prepare.indexOf('prepared?.revision === args.expectedSnapshotRevision');
    const move = prepare.indexOf('mv -- ${shellQuote(PREPARED_VALIDATION_ROOT)}');
    const fallbackInstall = prepare.indexOf('INSTALL_COMMAND, INSTALL_TIMEOUT_MS');

    expect(reusable).toBeGreaterThan(0);
    expect(move).toBeGreaterThan(reusable);
    expect(fallbackInstall).toBeGreaterThan(move);
    expect(prepare).toContain('PREVIEW_PREPARATION_COMMANDS');
    expect(prepare).toContain('DELETE FROM ghostbuild_prepared_validation WHERE singleton = 1');
  });

  it('keeps the Computer container alive for stateful and deployment operations', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const deployment = source.slice(
      source.indexOf('async prepareDeploymentArtifact('),
      source.indexOf('async deleteProject('),
    );
    const statefulOperation = source.slice(
      source.indexOf('private async withStatefulOperation'),
      source.indexOf('private requireCompletedComputerSync'),
    );
    const keepAlive = source.slice(
      source.indexOf('private async withContainerKeepAlive'),
      source.indexOf('private requireCompletedComputerSync'),
    );

    expect(deployment).toContain('return await this.withContainerKeepAlive(operation)');
    expect(statefulOperation).toContain('return await this.withContainerKeepAlive(operation)');
    expect(keepAlive).toContain('this.#containerKeepAliveOperations += 1');
    expect(keepAlive).toContain('await this.setKeepAlive(true)');
    expect(keepAlive).toContain('this.#containerKeepAliveOperations -= 1');
    expect(keepAlive).toContain('this.#containerKeepAliveOperations === 0 && !this.activePreviewRow()');
    expect(keepAlive).toContain('await this.setKeepAlive(false)');
  });

  it('uses the public Computer filesystem for durable workspace changes', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const applyChanges = source.slice(source.indexOf('async applyChanges('), source.indexOf('async getSyncPage('));

    expect(applyChanges).toContain('await this.withComputer');
    expect(applyChanges).toContain('workspace.fs.rm');
    expect(applyChanges).toContain('writeWorkspaceFile(workspace');
    expect(applyChanges).not.toContain('transactionSync');
    expect(applyChanges).not.toContain('.provider()');
  });
});
