import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DATABASE_NAME = 'ghostbuild';

export function parseD1TimeTravelBookmark(output) {
  const result = JSON.parse(output);
  if (!result || typeof result !== 'object' || typeof result.bookmark !== 'string') {
    throw new Error('Cloudflare D1 Time Travel did not return a bookmark.');
  }
  const bookmark = result.bookmark.trim();
  if (!/^[A-Za-z0-9-]+$/.test(bookmark)) {
    throw new Error('Cloudflare D1 Time Travel returned an invalid bookmark.');
  }
  return bookmark;
}

export function formatD1RestoreSummary(bookmark, commitSha = '') {
  const commit = commitSha.trim() || 'local deployment';
  return [
    '### Pre-migration D1 restore point',
    '',
    `- Database: \`${DATABASE_NAME}\``,
    `- Commit: \`${commit}\``,
    `- Bookmark: \`${bookmark}\``,
    `- Restore command: \`pnpm exec wrangler d1 time-travel restore ${DATABASE_NAME} --bookmark=${bookmark}\``,
    '',
  ].join('\n');
}

export function recordD1TimeTravelBookmark({
  query = () =>
    execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'time-travel', 'info', DATABASE_NAME, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  githubOutput = process.env.GITHUB_OUTPUT,
  githubStepSummary = process.env.GITHUB_STEP_SUMMARY,
  commitSha = process.env.GITHUB_SHA ?? '',
} = {}) {
  const bookmark = parseD1TimeTravelBookmark(query());
  const summary = formatD1RestoreSummary(bookmark, commitSha);

  if (githubOutput) {
    appendFileSync(githubOutput, `bookmark=${bookmark}\n`, 'utf8');
  }
  if (githubStepSummary) {
    appendFileSync(githubStepSummary, summary, 'utf8');
  }

  process.stdout.write(`${summary}\n`);
  return bookmark;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  recordD1TimeTravelBookmark();
}
