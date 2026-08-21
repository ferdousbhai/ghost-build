import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { STAGE_LOG_TAIL_BYTES, parallelStagesTimeoutMs, parallelValidationStagesCommand } from './validation-stages';

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const scratch = mkdtempSync(join(tmpdir(), 'ghostbuild-stages-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(stages: { name: string; command: string }[]) {
  const command = parallelValidationStagesCommand(stages, { logRoot: join(scratch, 'logs'), quote: shellQuote });
  return spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
}

describe('parallel validation stages', () => {
  it('runs stages concurrently rather than end to end', () => {
    // Three half-second sleeps in series take 1.5s. The whole point is that they do not.
    const started = Date.now();
    const result = run([
      { name: 'a', command: 'sleep 0.5' },
      { name: 'b', command: 'sleep 0.5' },
      { name: 'c', command: 'sleep 0.5' },
    ]);

    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_200);
  });

  it('fails the group and names every stage that failed', () => {
    const result = run([
      { name: 'passes', command: 'true' },
      { name: 'typecheck', command: 'echo "TS1005: expected" >&2; exit 2' },
      { name: 'lint', command: 'echo "no-unused-vars" >&2; exit 1' },
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('===== typecheck failed =====');
    expect(result.stderr).toContain('TS1005: expected');
    expect(result.stderr).toContain('===== lint failed =====');
    expect(result.stderr).toContain('no-unused-vars');
    expect(result.stderr).not.toContain('passes failed');
  });

  it('surfaces the end of a failing stage log, where the error is', () => {
    // A build that fails after printing megabytes must not push its own error out of the
    // bounded exec stream.
    const result = run([
      { name: 'noisy', command: `for i in $(seq 1 4000); do echo "line $i padding padding"; done; echo BOOM; exit 1` },
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BOOM');
    expect(result.stderr.length).toBeLessThan(STAGE_LOG_TAIL_BYTES + 2_000);
  });

  it('keeps a passing group quiet', () => {
    const result = run([{ name: 'quiet', command: 'echo lots of build output' }]);

    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe('');
  });

  it('refuses a stage name that would not be a safe log file or shell word', () => {
    for (const name of ['../escape', 'has space', 'Upper', '']) {
      expect(() =>
        parallelValidationStagesCommand([{ name, command: 'true' }], {
          logRoot: '/tmp/x',
          quote: shellQuote,
        }),
      ).toThrow();
    }
  });

  it('refuses duplicate stage names that would share one log file', () => {
    expect(() =>
      parallelValidationStagesCommand(
        [
          { name: 'lint', command: 'true' },
          { name: 'lint', command: 'false' },
        ],
        { logRoot: '/tmp/x', quote: shellQuote },
      ),
    ).toThrow(/Duplicate/);
  });

  it('bounds the group by its slowest stage, not the sum of all of them', () => {
    expect(parallelStagesTimeoutMs([{ timeoutMs: 60_000 }, { timeoutMs: 5 * 60_000 }])).toBe(5 * 60_000);
  });
});
