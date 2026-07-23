import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  D1_RESTORE_RECEIPT_MARKER,
  formatD1RestoreSummary,
  parseD1TimeTravelBookmark,
  recordD1TimeTravelBookmark,
  resolveReleaseIdentity,
} from './record-d1-time-travel-bookmark.mjs';

const commitSha = 'a'.repeat(40);

describe('D1 Time Travel bookmark recording', () => {
  it('parses a valid Wrangler response and rejects missing or unsafe values', () => {
    expect(parseD1TimeTravelBookmark('{"bookmark":"00000000-0000-0000-0000-000000000000"}')).toBe(
      '00000000-0000-0000-0000-000000000000',
    );
    expect(() => parseD1TimeTravelBookmark('{}')).toThrow('did not return a bookmark');
    expect(() => parseD1TimeTravelBookmark('{"bookmark":"unsafe value"}')).toThrow('returned an invalid bookmark');
  });

  it('formats the exact restore command with a local fallback', () => {
    expect(formatD1RestoreSummary('bookmark-1')).toContain(
      '`pnpm exec wrangler d1 time-travel restore ghostbuild --bookmark=bookmark-1`',
    );
    expect(formatD1RestoreSummary('bookmark-1')).toContain('`local deployment`');
  });

  it('resolves Workers Builds release identity from provider metadata', () => {
    expect(
      resolveReleaseIdentity({
        env: {
          WORKERS_CI: '1',
          WORKERS_CI_BUILD_UUID: '11111111-2222-3333-8444-555555555555',
          WORKERS_CI_COMMIT_SHA: commitSha,
        },
        resolveGitCommit: () => {
          throw new Error('git fallback must not run');
        },
      }),
    ).toEqual({
      buildUuid: '11111111-2222-3333-8444-555555555555',
      commitSha,
      provider: 'cloudflare-workers-builds',
    });
  });

  it('writes GitHub outputs and the step summary when those files are available', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ghostbuild-d1-bookmark-'));
    const output = join(directory, 'output');
    const summary = join(directory, 'summary');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      expect(
        recordD1TimeTravelBookmark({
          query: () => '{"bookmark":"bookmark-2"}',
          githubOutput: output,
          githubStepSummary: summary,
          identity: { buildUuid: '', commitSha, provider: 'github-actions' },
        }),
      ).toBe('bookmark-2');
      expect(readFileSync(output, 'utf8')).toBe('bookmark=bookmark-2\n');
      expect(readFileSync(summary, 'utf8')).toContain(`- Commit: \`${commitSha}\``);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining(D1_RESTORE_RECEIPT_MARKER));
    } finally {
      stdout.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
