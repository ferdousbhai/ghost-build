import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertPreviewPublicationAllowed,
  assertPreviewSourceCheckpoint,
  previewExpirationAction,
  PREVIEW_PORT_COUNT,
  PREVIEW_PORT_MIN,
  previewPort,
} from './preview-lifecycle';

describe('ProjectWorkspace preview lifecycle', () => {
  const revision = 'a'.repeat(64);

  it('requires both the durable VFS revision and exact source digest', () => {
    const expected = { workspaceRevision: 12, revision };
    expect(assertPreviewSourceCheckpoint(expected, expected, true)).toEqual(expected);
    expect(() => assertPreviewSourceCheckpoint({ ...expected, workspaceRevision: 13 }, expected, true)).toThrow(
      /project changed/i,
    );
    expect(() => assertPreviewSourceCheckpoint({ ...expected, revision: 'b'.repeat(64) }, expected, true)).toThrow(
      /project changed/i,
    );
  });

  it('accepts derived build-output revision churn but still rejects source mutation', () => {
    const expected = { workspaceRevision: 12, revision };
    expect(assertPreviewSourceCheckpoint({ workspaceRevision: 99, revision }, expected, false)).toEqual({
      workspaceRevision: 99,
      revision,
    });
    expect(() =>
      assertPreviewSourceCheckpoint({ workspaceRevision: 99, revision: 'b'.repeat(64) }, expected, false),
    ).toThrow(/project changed/i);
  });

  it('chooses a bounded replacement port without reusing the active preview port', () => {
    const first = previewPort('preview-a');
    const replacement = previewPort('preview-a', first);
    expect(first).toBeGreaterThanOrEqual(PREVIEW_PORT_MIN);
    expect(first).toBeLessThan(PREVIEW_PORT_MIN + PREVIEW_PORT_COUNT);
    expect(replacement).not.toBe(first);
  });

  it('does not let an earlier cleanup alarm expire a preview with a later durable deadline', () => {
    const now = 1_000;
    expect(previewExpirationAction(now + 60_000, now)).toEqual({ action: 'reschedule', at: now + 60_000 });
    expect(previewExpirationAction(61_999, 61_100)).toEqual({ action: 'reschedule', at: 62_000 });
    expect(previewExpirationAction(now, now)).toEqual({ action: 'expire' });
    expect(previewExpirationAction(null, now)).toEqual({ action: 'expire' });
  });

  it('persists cancellation outside the serialized build lane and checks it before publication', () => {
    expect(() => assertPreviewPublicationAllowed(true)).toThrow(/cancelled before publication/i);
    expect(() => assertPreviewPublicationAllowed(false)).not.toThrow();

    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const stop = source.slice(source.indexOf('async stopPreview('), source.indexOf('async expirePreview('));
    expect(stop.indexOf('INSERT INTO ghostbuild_preview_cancellations')).toBeLessThan(
      stop.indexOf("withStatefulOperation('preview'"),
    );
    const create = source.slice(source.indexOf('async createPreview('), source.indexOf('async stopPreview('));
    expect(create.lastIndexOf('requirePreviewNotCancelled(previewId)')).toBeLessThan(
      create.indexOf('INSERT INTO ghostbuild_active_preview'),
    );
  });

  it('applies the isolated local D1 schema before building Preview', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const create = source.slice(source.indexOf('async createPreview('), source.indexOf('async stopPreview('));
    expect(create).toContain('pnpm exec wrangler d1 migrations apply DB --local --config wrangler.preview.jsonc');
    expect(create.indexOf('d1 migrations apply DB --local')).toBeLessThan(
      create.indexOf('pnpm run build:isolated-preview'),
    );
  });

  it('durably tracks and bounds the process before launching Preview', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const create = source.slice(source.indexOf('async createPreview('), source.indexOf('async stopPreview('));
    const schedule = create.indexOf("await this.schedule(new Date(cleanupDeadline), 'expirePreview'");
    const persist = create.indexOf('this.upsertPendingPreview(candidate, cleanupDeadline)');
    const isolate = create.indexOf('createIsolatedProjectCommand');
    const launch = create.indexOf('await this.startProcess(');

    expect(schedule).toBeGreaterThan(0);
    expect(persist).toBeGreaterThan(0);
    expect(persist).toBeLessThan(schedule);
    expect(schedule).toBeLessThan(isolate);
    expect(persist).toBeLessThan(launch);
    expect(create).toContain('timeout --signal=KILL ${Math.ceil(PREVIEW_TTL_MS / 1_000)}s');
    expect(create).toContain('DELETE FROM ghostbuild_pending_previews WHERE preview_id = ?');
  });

  it('recovers pending Preview processes through stop and expiry paths', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const stop = source.slice(source.indexOf('async stopPreview('), source.indexOf('async expirePreview('));
    const expire = source.slice(
      source.indexOf('async expirePreview('),
      source.indexOf('async prepareDeploymentArtifact('),
    );
    const cleanup = source.slice(
      source.indexOf('private async cleanupPendingPreviews('),
      source.indexOf('private pendingPreviewRow('),
    );

    expect(stop).toContain('pendingPreviewRow(previewId)');
    expect(stop).toContain('cleanupPreviewResources(pending)');
    expect(stop).toContain('pending && !this.activePreviewRow()');
    expect(expire).toContain("await this.schedule(30, 'expirePreview', { previewId })");
    expect(cleanup.indexOf('await this.cleanupPreviewResources(row)')).toBeLessThan(
      cleanup.indexOf('DELETE FROM ghostbuild_pending_previews WHERE preview_id = ?'),
    );
    expect(cleanup.indexOf('DELETE FROM ghostbuild_pending_previews WHERE preview_id = ?')).toBeLessThan(
      cleanup.indexOf('} catch (error)'),
    );
    expect(source).toContain('CREATE TABLE IF NOT EXISTS ghostbuild_pending_previews');
    expect(source).not.toContain("this.deleteSchedules('expirePreview')");
  });

  it('preserves the prior Preview as pending until replacement cleanup succeeds', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const create = source.slice(source.indexOf('async createPreview('), source.indexOf('async stopPreview('));
    const preservePrevious = create.indexOf('this.upsertPendingPreview(previous');
    const publishReplacement = create.indexOf('INSERT INTO ghostbuild_active_preview');
    const deleteRecoveredPrevious = create.lastIndexOf('DELETE FROM ghostbuild_pending_previews WHERE preview_id = ?');

    expect(preservePrevious).toBeGreaterThan(0);
    expect(preservePrevious).toBeLessThan(publishReplacement);
    expect(deleteRecoveredPrevious).toBeGreaterThan(publishReplacement);
    expect(create.lastIndexOf('DELETE FROM ghostbuild_preview_results WHERE preview_id = ?')).toBeGreaterThan(
      publishReplacement,
    );
  });

  it('replays only the currently active Preview result', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const create = source.slice(source.indexOf('async createPreview('), source.indexOf('async stopPreview('));
    const replay = create.slice(create.indexOf('const replay ='), create.indexOf('return this.withStatefulOperation('));

    expect(replay).toContain('this.activePreviewRow()?.preview_id === previewId');
  });
});
