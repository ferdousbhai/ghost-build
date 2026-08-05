import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertPreviewPublicationAllowed,
  assertPreviewSourceCheckpoint,
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
});
