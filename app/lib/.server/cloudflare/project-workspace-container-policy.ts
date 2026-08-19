/**
 * `standard-1` rather than `basic`, because a workspace has to install a dependency tree
 * and typecheck a generated project inside this container. On `basic` (0.25 vCPU, 1 GiB) a
 * typecheck produced no output for nine minutes; Cloudflare's own Computer performance work
 * benchmarks on `standard-2`. This is the smallest step that quadruples memory, which is the
 * likelier constraint of the two, and it costs cents per build.
 */
export const PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE = 'standard-1';
export const PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES = 10;

/**
 * The dimensions Cloudflare resolves the tier to. A readback echoes either the tier name or
 * these, so they have to move together — a readback that still recognised only the previous
 * tier's shape would accept a container the policy no longer asks for.
 */
export const PROJECT_WORKSPACE_CONTAINER_DIMENSIONS = {
  vcpu: 0.5,
  memoryMib: 4_096,
  diskMb: 8_000,
} as const;
