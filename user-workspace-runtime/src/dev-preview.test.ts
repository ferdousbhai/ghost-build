import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  containerParentDirectory,
  devPreviewProjectedPath,
  devPreviewRemoveCommand,
  devPreviewRoot,
  devPreviewServerCommand,
  requirePreviewMode,
  storedPreviewMode,
} from './dev-preview';
import { PREVIEW_SNAPSHOT_ROOT } from './preview-lifecycle';

describe('dev preview mode', () => {
  it('defaults an unspecified or legacy mode to the checkpoint-bound preview', () => {
    expect(requirePreviewMode(undefined)).toBe('production');
    expect(requirePreviewMode('production')).toBe('production');
    expect(requirePreviewMode('dev')).toBe('dev');
    expect(storedPreviewMode(null)).toBe('production');
    expect(storedPreviewMode(undefined)).toBe('production');
    expect(storedPreviewMode('dev')).toBe('dev');
  });

  it('rejects an unknown mode rather than silently downgrading the guarantee', () => {
    expect(() => requirePreviewMode('development')).toThrow(/invalid preview mode/i);
    expect(() => requirePreviewMode('')).toThrow(/invalid preview mode/i);
    expect(() => requirePreviewMode(1)).toThrow(/invalid preview mode/i);
  });

  it('keeps the dev server out of the durable VFS projection', () => {
    const root = devPreviewRoot('preview-a');

    expect(root.startsWith(`${PREVIEW_SNAPSHOT_ROOT}/`)).toBe(true);
    expect(root.startsWith('/home')).toBe(false);
    expect(devPreviewRoot('preview-b')).not.toBe(root);
  });

  it('runs the dev server against the isolated preview Wrangler configuration', () => {
    const command = devPreviewServerCommand(4_180);

    expect(command).toContain('vite dev');
    expect(command).toContain('--mode ghostbuild-isolated-preview');
    expect(command).toContain('--port 4180');
    expect(command).toContain('--strictPort');
    expect(command).not.toContain('vite build');
    expect(command).not.toContain('vite preview');
    expect(command).not.toContain('build:isolated-preview');
  });

  it('projects a durable path into the dev root and refuses to escape it', () => {
    expect(
      devPreviewProjectedPath({
        devRoot: '/tmp/ghostbuild-previews/dev-a',
        projectRoot: '/home/project',
        path: '/home/project/src/routes/index.tsx',
      }),
    ).toBe('/tmp/ghostbuild-previews/dev-a/src/routes/index.tsx');

    for (const path of ['/home/projectile/app.ts', '/home/project', '/home/project/../secrets', '/etc/passwd']) {
      expect(() =>
        devPreviewProjectedPath({ devRoot: '/tmp/ghostbuild-previews/dev-a', projectRoot: '/home/project', path }),
      ).toThrow(/outside the project root/i);
    }
  });

  it('names the parent directory a projected write has to create', () => {
    expect(containerParentDirectory('/tmp/dev-a/src/routes/index.tsx')).toBe('/tmp/dev-a/src/routes');
    expect(containerParentDirectory('/index.tsx')).toBe('/');
  });

  it('quotes every removed path so a deletion cannot become a shell injection', () => {
    const command = devPreviewRemoveCommand({
      paths: ['/tmp/dev-a/src/gone.ts', "/tmp/dev-a/src/it's here.ts"],
      quote: (value) => `'${value.replaceAll("'", "'\\''")}'`,
    });

    expect(command.startsWith('set -eu\n')).toBe(true);
    expect(command).toContain("rm -rf -- '/tmp/dev-a/src/gone.ts'");
    expect(command).toContain("rm -rf -- '/tmp/dev-a/src/it'\\''s here.ts'");
  });
});

describe('ProjectWorkspace dev preview wiring', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const create = source.slice(source.indexOf('async createPreview('), source.indexOf('async stopPreview('));

  it('asserts the source checkpoint for a production preview and never for a dev preview', () => {
    const devBranch = create.slice(create.indexOf("if (mode === 'dev') {"), create.indexOf('} else {'));
    const productionBranch = create.slice(create.indexOf('} else {'), create.indexOf('const expiresAt ='));

    expect(devBranch).toContain('this.prepareDevPreviewRoot({ previewId, devRoot: snapshotRoot })');
    // The whole distinction: a preview that tracks live state has no revision to assert, and
    // asserting one would fail the moment the project it follows moves.
    expect(devBranch).not.toContain('assertPreviewCheckpoint');
    expect(productionBranch).toContain('this.preparePreviewSnapshot({');
    expect(productionBranch).toContain('assertPreviewCheckpoint(expectedWorkspaceRevision, expectedSnapshotRevision');
    // Entry assertion, post-build assertion, pre-publication assertion: production only. The
    // replay guard is the third production-only branch, so a stored dev result is never rejected
    // for naming a revision it was never asked for.
    expect(create.match(/assertPreviewCheckpoint/g)).toHaveLength(3);
    expect(create.match(/mode === 'production'/g)).toHaveLength(3);
    expect(
      create.slice(create.indexOf('const replay ='), create.indexOf('return this.withStatefulOperation(')),
    ).toContain("mode === 'production' &&");
  });

  it('stores no source digest for a dev preview and accepts no expected revision', () => {
    expect(create).toContain("const expectedSnapshotRevision = mode === 'dev' ? '' : requireSnapshotRevision(");
    expect(create).toContain("mode === 'dev'\n        ? this.currentRevision()");
    // Not `checkpoint()`: hashing the tree would both cost a full read and imply a binding the
    // next edit immediately breaks.
    expect(create).not.toContain('await this.checkpoint()');
  });

  it('adds the mode column to preview tables an older workspace already created', () => {
    // `CREATE TABLE IF NOT EXISTS` never revisits an existing table, so a workspace provisioned
    // before dev previews would keep selecting a column its schema does not have.
    for (const table of ['ghostbuild_active_preview', 'ghostbuild_pending_previews', 'ghostbuild_preview_results']) {
      expect(source).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(source).toContain('PRAGMA table_info(${table})');
    expect(source).toContain("ALTER TABLE ${table} ADD COLUMN mode TEXT NOT NULL DEFAULT 'production'");
    expect(source.match(/mode TEXT NOT NULL DEFAULT 'production'/g)).toHaveLength(4);
  });

  it('reuses one preview lifecycle for both modes rather than a parallel one', () => {
    expect(create).toContain('this.upsertPendingPreview(candidate, cleanupDeadline)');
    expect(create).toContain("await this.schedule(new Date(expiresAt), 'expirePreview', { previewId })");
    expect(create).toContain('createReachablePreviewTunnel(this.tunnels, port');
    expect(create).toContain('assertActive: () => this.requirePreviewNotCancelled(previewId)');
    expect(create).toContain('const expiresAt = Date.now() + PREVIEW_TTL_MS');
    expect(create).toContain('await this.setKeepAlive(true)');
    // One active preview row, one expiry alarm, one cleanup path: the mode only selects how the
    // root is prepared and which server command runs inside it.
    expect(source).not.toContain('ghostbuild_active_dev_preview');
    expect(source).not.toContain('async createDevPreview(');
  });

  it('installs dependencies once for a dev preview and never builds for production output', () => {
    const prepare = source.slice(
      source.indexOf('private async prepareDevPreviewRoot('),
      source.indexOf('private async projectChangesIntoDevPreview('),
    );

    // The dev root is materialised through the same verified copy every other build path uses, so
    // a dev preview cannot serve stale files either (#139).
    expect(prepare).toContain('copyProjectToIsolatedRoot');
    expect(prepare).toContain('INSTALL_COMMAND, INSTALL_TIMEOUT_MS');
    expect(prepare).toContain('DEV_PREVIEW_PREPARATION_COMMANDS');
    expect(prepare).not.toContain('build:isolated-preview');
    // The prepared validation snapshot is evidence for the checkpoint-bound path; a dev preview
    // must not consume or discard it.
    expect(prepare).not.toContain('discardPreparedValidationSnapshot');
    expect(prepare).not.toContain('PREPARED_VALIDATION_ROOT');
  });

  it('delivers a committed change to a live dev preview without rebuilding it', () => {
    const project = source.slice(
      source.indexOf('private async projectChangesIntoDevPreview('),
      source.indexOf('private async cleanupPreviewResources('),
    );
    const applyChanges = source.slice(source.indexOf('async applyChanges('), source.indexOf('async getSyncPage('));

    expect(applyChanges.indexOf('applyAtomicWorkspaceChanges(this.#workspace, atomicChanges')).toBeLessThan(
      applyChanges.indexOf('await this.projectChangesIntoDevPreview(atomicChanges)'),
    );
    expect(project).toContain("if (active?.mode !== 'dev'");
    expect(project).toContain('devPreviewProjectedPath({');
    expect(project).toContain('devPreviewRemoveCommand({');
    expect(project).not.toContain('createPreview');
    expect(project).not.toContain('build:isolated-preview');
    // A preview that cannot be refreshed must not fail a durable write that already committed.
    expect(project).toContain('} catch (error) {');
    expect(project).toContain('console.warn(');
  });

  it('reports a dev preview without a bound source revision', () => {
    const success = source.slice(
      source.indexOf('function previewSuccess('),
      source.indexOf('function requireFileInputs('),
    );

    expect(success).toContain("mode: 'dev', startedFromWorkspaceRevision: row.workspace_revision");
    expect(success).toContain('snapshotRevision: row.snapshot_revision');
    expect(success.indexOf('snapshotRevision')).toBeGreaterThan(success.indexOf('startedFromWorkspaceRevision'));
  });

  it('retires whichever preview is active before an immutable deployment session starts', () => {
    const session = source.slice(
      source.indexOf('async beginDeploymentSession('),
      source.indexOf('async createPreview('),
    );

    // Mode-agnostic on purpose: a dev preview holds the same container and must not survive into
    // a deployment that pins an exact revision.
    expect(session).toContain('await this.cleanupPendingPreviews()');
    expect(session).toContain('await this.stopActivePreview()');
    expect(session).not.toContain("mode === 'dev'");
  });
});
