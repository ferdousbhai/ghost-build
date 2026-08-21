import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContainerDirectoryCommand, rebaseDeploymentConfigPaths, relativeIsolatedPath } from './isolated-project';

describe('isolated project command', () => {
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
      // Both build from an isolated root written out of the durable VFS. Neither reads the
      // container mount, which is what made #139 possible: a build copying from one source of
      // truth while its guards checked another.
      expect(operation).toContain('copyProjectToIsolatedRoot');
      expect(operation).not.toContain('pushDurableProjectToContainer');
      expect(operation).toContain('runTransientCommand');
      expect(operation).toContain('INSTALL_TIMEOUT_MS');
      expect(operation).not.toContain('workspace.runtime.exec');
      expect(operation).not.toContain('removeDerivedFiles');
    }
    expect(preview).toContain('this.preparePreviewSnapshot({');
    expect(preview).not.toContain('INSTALL_COMMAND');
    expect(preview).not.toContain('pnpm run build:isolated-preview');
    expect(source).toContain('const INSTALL_TIMEOUT_MS = CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS;');
    expect(deployment).toContain('rebaseDeploymentConfigPaths');
    expect(deployment).toContain('collectSandboxFiles(this, artifactRoot');
    expect(deployment).toContain('node --input-type=module --eval');
    expect(deployment).toContain('`${isolatedRoot}/dist/server/index.js`');
    expect(source).toContain("createRequire(import.meta.resolve('vite'))");
    expect(source).toContain('cloudflare:*');
    expect(deployment).not.toContain('pnpm exec esbuild');
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
    // Codegen first and alone, because it writes the route tree and binding types the other
    // stages read; everything else runs as one concurrent group inside the same isolated root.
    expect(validation).toContain('REVISION_CODEGEN_COMMAND.command');
    expect(validation).toContain('parallelValidationStagesCommand(PARALLEL_VALIDATION_STAGES');
    expect(validation.indexOf('REVISION_CODEGEN_COMMAND.command')).toBeLessThan(
      validation.indexOf('parallelValidationStagesCommand(PARALLEL_VALIDATION_STAGES'),
    );
    // Validation still leaves the preview its prepared build, which is what lets a preview skip
    // straight to starting a server.
    expect(source).toContain("{ name: 'preview_build', command: 'pnpm run build:isolated-preview'");
    expect(validation).toContain('ghostbuild_prepared_validation');
    expect(deployment).toContain("await this.runTransientCommand(isolatedRoot, 'pnpm run build', 5 * 60_000)");
    expect(deployment).not.toContain('pnpm run typecheck');
    expect(deployment).not.toContain('pnpm run verify:stack');
    expect(deployment).not.toContain('pnpm run lint');
    // Cancellation is still observed before the expensive materialisation, which now happens
    // inside the verified copy rather than at this call site.
    const initialCheckpoint = validation.indexOf('const before = await this.checkpoint()');
    const isolationCopy = validation.indexOf('await this.copyProjectToIsolatedRoot(');
    expect(initialCheckpoint).toBeGreaterThanOrEqual(0);
    expect(isolationCopy).toBeGreaterThan(initialCheckpoint);
    expect(validation.indexOf('cancellation.requireActive()', initialCheckpoint)).toBeLessThan(isolationCopy);
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
    expect(materialization.match(/await this\.#workspace\.push\('container-shell'\)/g)).toHaveLength(1);
    expect(materialization).toContain('if (!force && (await this.exists(PROJECT_ROOT)).exists)');
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
    expect(statefulOperation).toContain('await this.withContainerKeepAlive(() => operation(');
    expect(keepAlive).toContain('this.#containerKeepAliveOperations += 1');
    expect(keepAlive).toContain('await this.setKeepAlive(true)');
    expect(keepAlive).toContain('this.#containerKeepAliveOperations -= 1');
    expect(keepAlive).toContain("ghostbuild_deployment_sessions WHERE status = 'active'");
    expect(keepAlive).toContain(
      'this.#containerKeepAliveOperations === 0 && !this.activePreviewRow() && !deploymentActive',
    );
    expect(keepAlive).toContain('await this.setKeepAlive(false)');
  });

  it('retires the active preview before an immutable deployment session starts', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const session = source.slice(
      source.indexOf('async beginDeploymentSession('),
      source.indexOf('async createPreview('),
    );
    expect(session.match(/await this\.setKeepAlive\(true\)/g)).toHaveLength(2);
    const retain = session.indexOf('await this.setKeepAlive(true)');
    const cleanup = session.indexOf('await this.cleanupPendingPreviews()');
    const stop = session.indexOf('await this.stopActivePreview()');
    const assertion = session.lastIndexOf('await this.assertDeploymentSession({ sessionId: operationId })');

    expect(retain).toBeGreaterThan(0);
    expect(cleanup).toBeGreaterThan(retain);
    expect(stop).toBeGreaterThan(cleanup);
    expect(assertion).toBeGreaterThan(stop);
  });

  it('publishes each durable workspace change set through one atomic VFS batch', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const applyChanges = source.slice(source.indexOf('async applyChanges('), source.indexOf('async getSyncPage('));

    expect(applyChanges).toContain('applyAtomicWorkspaceChanges(');
    expect(applyChanges).toContain('assertMutationAllowed');
    expect(applyChanges).not.toContain('workspace.fs.rm');
    expect(applyChanges).not.toContain('writeWorkspaceFile(workspace');
  });

  it('stages dependency updates away from the live project before atomic publication', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const install = source.slice(
      source.indexOf('async installDependenciesTool('),
      source.indexOf('async validateTool('),
    );

    expect(install).toContain('stagingRoot');
    expect(install).toContain('cwd: stagingRoot');
    expect(install).toContain('applyAtomicWorkspaceChanges(');
    expect(install.indexOf('requireCommandSuccess(await installation)')).toBeLessThan(
      install.indexOf('applyAtomicWorkspaceChanges('),
    );
    expect(install.indexOf('applyAtomicWorkspaceChanges(')).toBeLessThan(
      install.indexOf('this.#toolOperations.complete({ toolCallId, result })'),
    );
  });
});

describe('#139 stale-bytes guard', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('never builds from the container mount', () => {
    // The mount is the second source of truth that made #139 possible. Builds are now written out
    // of the durable VFS, so a `tar` of PROJECT_ROOT reappearing anywhere is the regression.
    expect(source).not.toContain('createIsolatedProjectCommand');
    expect(source).not.toMatch(/tar -C \$\{?shellQuote\(PROJECT_ROOT/);
    expect(source.split('await this.copyProjectToIsolatedRoot(').length - 1).toBe(4);
  });

  it('writes the isolated root from the durable VFS, one file at a time', () => {
    const helper = source.slice(
      source.indexOf('private async copyProjectToIsolatedRoot('),
      source.indexOf("   * Prove the container's own view"),
    );
    expect(helper).toContain('readProjectFilePaths');
    expect(helper).toContain('readWorkspaceFile(workspace, file.path)');
    // Bounded concurrency, because each worker holds one file and the isolate has 128 MiB.
    expect(helper).toContain('forEachConcurrently(files, MATERIALIZATION_CONCURRENCY');
    expect(helper).toContain('containerPathMatchesDurableProject');
  });

  it('compares the copy against durable truth and can force a re-materialisation', () => {
    const helper = source.slice(
      source.indexOf('private async copyProjectToIsolatedRoot('),
      source.indexOf('private async pushDurableProjectToContainer('),
    );
    expect(helper).toContain('containerPathMatchesDurableProject');
    // The retry must actually force the push; a second ordinary push would short-circuit on the
    // very `exists` check that made the stale mount look healthy.
    expect(helper).toContain('for (const forcePush of [false, true])');
    expect(helper).toContain('pushDurableProjectToContainer(forcePush)');
  });

  it("guards the model's own exec against the same stale mount, once per container generation", () => {
    // The build paths copy from the mount and verify the copy; `exec` runs against the mount
    // directly with `cwd` defaulting to PROJECT_ROOT. Without this the #139 shape survives there:
    // `read` returns the new file and `pnpm run test` runs the old one.
    expect(source.split('await this.assertContainerMatchesDurableProject();').length - 1).toBe(2);
    const guard = source.slice(
      source.indexOf('private async assertContainerMatchesDurableProject('),
      source.indexOf('private async containerPathMatchesDurableProject('),
    );
    expect(guard).toContain('this.#verifiedContainerGeneration');
    expect(guard).toContain('for (const forcePush of [false, true])');
  });

  it('does not let a present mount stand in for correct content', () => {
    const push = source.slice(
      source.indexOf('private async pushDurableProjectToContainer('),
      source.indexOf('private async runTransientCommand('),
    );
    expect(push).toContain('if (!force && (await this.exists(PROJECT_ROOT)).exists)');
  });
});
