import { describe, expect, it, vi } from 'vitest';
import {
  uploadWorkersBuildsPreview,
  validatePreviewBuildContext,
  wranglerPreviewUploadArgs,
} from './upload-workers-builds-preview.mjs';

const commitSha = 'a'.repeat(40);
const previewEnv = {
  WORKERS_CI: '1',
  WORKERS_CI_BRANCH: 'feature/cloudflare-preview',
  WORKERS_CI_BUILD_UUID: '11111111-2222-3333-8444-555555555555',
  WORKERS_CI_COMMIT_SHA: commitSha,
  CLOUDFLARE_OAUTH_CLIENT_ID: 'oauth-client-id',
};

describe('Workers Builds preview upload', () => {
  it('accepts only a non-production Workers Builds checkout', () => {
    expect(validatePreviewBuildContext({ env: previewEnv, currentCommitSha: commitSha })).toEqual({
      branch: 'feature/cloudflare-preview',
      commitSha,
    });
    expect(() =>
      validatePreviewBuildContext({
        env: { ...previewEnv, WORKERS_CI_BRANCH: 'main' },
        currentCommitSha: commitSha,
      }),
    ).toThrow('refuses the production branch');
  });

  it('uploads a version with reviewed variables without promoting it', () => {
    expect(wranglerPreviewUploadArgs('oauth-client-id', commitSha, 'feature/cloudflare-preview')).toEqual([
      'exec',
      'wrangler',
      'versions',
      'upload',
      '--var',
      `COMMIT_SHA:${commitSha}`,
      '--var',
      'CLOUDFLARE_OAUTH_CLIENT_ID:oauth-client-id',
      '--message',
      `Workers Builds preview for feature/cloudflare-preview at ${commitSha}`,
    ]);

    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `${commitSha}\n`, stderr: '' })
      .mockReturnValueOnce({ status: 0 });
    expect(uploadWorkersBuildsPreview({ env: previewEnv, spawn: spawn as never })).toBe(commitSha);
    expect(spawn).toHaveBeenLastCalledWith(
      'pnpm',
      wranglerPreviewUploadArgs('oauth-client-id', commitSha, 'feature/cloudflare-preview'),
      { stdio: 'inherit' },
    );
  });
});
