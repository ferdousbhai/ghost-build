import { describe, expect, it, vi } from 'vitest';
import { readUserWorkspaceRuntimeActivity } from './user-workspace-runtime-activity';

const secret = 'a'.repeat(64);

describe('user workspace runtime activity probe', () => {
  it.each([
    [true, 'busy'],
    [false, 'idle'],
  ])('reads a workspace that reports busy=%s', async (busy, expected) => {
    const request = vi.fn().mockResolvedValue(Response.json({ busy, observed: [], candidates: 1 }));

    await expect(read(request)).resolves.toBe(expected);
    expect(request).toHaveBeenCalledWith(
      'https://workspace.example/v1/activity',
      expect.objectContaining({ headers: { authorization: `Bearer ${secret}` } }),
    );
  });

  it.each([401, 403, 404])('separates a runtime that cannot be asked at all (HTTP %i)', async (status) => {
    // A runtime that predates this route reads the control-plane secret as a capability token and
    // answers 401, so it must not be able to defer the upgrade that would make it answerable.
    await expect(read(vi.fn().mockResolvedValue(new Response(null, { status })))).resolves.toBe('unreported');
  });

  it('keeps a runtime that would not assemble an answer separate from one that cannot be asked', async () => {
    await expect(read(vi.fn().mockResolvedValue(new Response(null, { status: 503 })))).resolves.toBe('unknown');
  });

  it('reports an unreachable workspace as unknown rather than as an idle one', async () => {
    await expect(read(vi.fn().mockRejectedValue(new Error('network down')))).resolves.toBe('unknown');
  });

  it('treats an answer it cannot parse as unknown', async () => {
    await expect(read(vi.fn().mockResolvedValue(Response.json({ observed: [] })))).resolves.toBe('unknown');
  });

  it('refuses to send the control-plane secret anywhere but the runtime over HTTPS', async () => {
    const request = vi.fn();

    await expect(
      readUserWorkspaceRuntimeActivity({ endpoint: 'http://workspace.example', controlPlaneSecret: secret, request }),
    ).resolves.toBe('unknown');
    await expect(
      readUserWorkspaceRuntimeActivity({ endpoint: 'https://workspace.example', controlPlaneSecret: 'short', request }),
    ).resolves.toBe('unknown');
    expect(request).not.toHaveBeenCalled();
  });
});

function read(request: typeof fetch) {
  return readUserWorkspaceRuntimeActivity({
    endpoint: 'https://workspace.example',
    controlPlaneSecret: secret,
    request,
  });
}
