/**
 * `standard-4` rather than `standard-1`, because every slow step a user waits on inside this
 * container is CPU-bound: `pnpm install`, `tsc`, `eslint`, and Vite/Rollup. `standard-1` gives
 * the workspace half a core, so a typecheck that takes seconds on a laptop takes minutes here,
 * and Rollup and tsc cannot use the parallelism they are built around.
 *
 * The tier is not a cost/speed trade. Cloudflare bills container CPU on *active usage*, so the
 * same work costs the same vCPU-seconds at any tier; memory and disk are billed on provisioned
 * size but only while the instance is awake, and four times the cores finishes in a small
 * fraction of the wall time. A build on `standard-4` therefore costs less than the same build on
 * `standard-1`.
 *
 * What does get more expensive is idling: a warm container holds 12 GiB instead of 4, roughly
 * $0.11 per idle hour, and the workspace is now warmed when a chat opens rather than when the
 * first command runs — so a chat nobody sends a message in still pays. The workspace runtime's
 * ten-minute idle window bounds that cost.
 */
export const PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE = 'standard-4';
export const PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES = 10;

/**
 * The dimensions Cloudflare resolves the tier to. A readback echoes either the tier name or
 * these, so they have to move together — a readback that still recognised only the previous
 * tier's shape would accept a container the policy no longer asks for.
 */
export const PROJECT_WORKSPACE_CONTAINER_DIMENSIONS = {
  vcpu: 4,
  memoryMib: 12_288,
  diskMb: 20_000,
} as const;
