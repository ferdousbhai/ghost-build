import { describe, expect, it } from 'vitest';
import { stableWorkspaceRead } from './stable-workspace-read';

describe('stableWorkspaceRead', () => {
  it('never labels old content with a concurrently committed newer revision', async () => {
    let revision = 1;
    let calls = 0;
    const result = await stableWorkspaceRead(
      () => revision,
      async () => {
        calls += 1;
        if (calls === 1) {
          revision = 2;
          return 'old content';
        }
        return 'new content';
      },
    );

    expect(result).toEqual({ value: 'new content', revision: 2 });
  });

  it('fails with a retryable conflict when all bounded attempts race a write', async () => {
    let revision = 0;
    await expect(
      stableWorkspaceRead(
        () => revision,
        async () => {
          revision += 1;
          return 'raced';
        },
      ),
    ).rejects.toMatchObject({ code: 'workspace_read_conflict' });
  });
});
