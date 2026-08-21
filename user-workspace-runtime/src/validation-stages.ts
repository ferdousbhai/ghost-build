/**
 * Run independent validation stages concurrently inside one container command.
 *
 * Validation used to walk its checks in series: typecheck, stack verification, lint, the preview
 * database migration, then the preview build. Only the first of those actually feeds the others —
 * `pnpm run typecheck` runs `tsr generate` and `wrangler types`, so the route tree and binding
 * types it writes are inputs to lint and to the build. Everything after it was serialized for no
 * reason, on a container that now has four cores to spend.
 *
 * The migration is safe to overlap with the build for the same reason it was safe to run before
 * it: its consumer is the preview *server*, which does not start until every stage has finished.
 *
 * This has to be one command rather than concurrent `runTransientCommand` calls, because that
 * helper tracks a single transient process role and terminates the previous occupant — two
 * parallel callers would kill each other.
 */

type ValidationStage = {
  /** Shell-safe identifier used for this stage's log file and failure heading. */
  readonly name: string;
  readonly command: string;
};

/**
 * Bytes of a failed stage's log to surface. Four stages at this size stay inside Computer's
 * reviewed 64 KiB exec output stream, so a runaway build log cannot truncate the failure that
 * explains it.
 */
export const STAGE_LOG_TAIL_BYTES = 8_000;

const STAGE_NAME = /^[a-z][a-z0-9_]*$/;

export function parallelValidationStagesCommand(
  stages: readonly ValidationStage[],
  options: { logRoot: string; quote: (value: string) => string },
): string {
  if (stages.length === 0) {
    throw new Error('A parallel validation group needs at least one stage.');
  }
  const names = new Set<string>();
  for (const stage of stages) {
    if (!STAGE_NAME.test(stage.name)) {
      throw new Error(`Invalid validation stage name: ${stage.name}`);
    }
    if (names.has(stage.name)) {
      throw new Error(`Duplicate validation stage name: ${stage.name}`);
    }
    names.add(stage.name);
  }

  const logs = options.quote(options.logRoot);
  const lines = [
    'set -u',
    `LOGS=${logs}`,
    'rm -rf "$LOGS"',
    'mkdir -p "$LOGS"',
    // A cancelled validation terminates this shell; without the trap its background stages would
    // outlive it and keep writing into a workspace that believes the operation ended.
    "trap 'kill 0' TERM INT",
  ];
  for (const [index, stage] of stages.entries()) {
    lines.push(`sh -c ${options.quote(stage.command)} >"$LOGS/${stage.name}.log" 2>&1 &`, `stage_pid_${index}=$!`);
  }
  lines.push('failed=');
  for (const [index, stage] of stages.entries()) {
    lines.push(`wait $stage_pid_${index} || failed="$failed ${stage.name}"`);
  }
  lines.push(
    'if [ -n "$failed" ]; then',
    '  for stage in $failed; do',
    `    printf '\\n===== %s failed =====\\n' "$stage" >&2`,
    `    tail -c ${STAGE_LOG_TAIL_BYTES} "$LOGS/$stage.log" >&2`,
    '  done',
    '  rm -rf "$LOGS"',
    '  exit 1',
    'fi',
    'rm -rf "$LOGS"',
  );
  return lines.join('\n');
}

/** The group's wall clock is its slowest stage, not the sum, because they run together. */
export function parallelStagesTimeoutMs(stages: readonly { timeoutMs: number }[]): number {
  return Math.max(...stages.map((stage) => stage.timeoutMs));
}
