/**
 * Restored snapshots are untrusted project data. Dependency resolution is
 * constrained by the managed npm environment. Keep the argv shape identical
 * to WebContainer's documented accelerated install command so it does not
 * fall back to materializing the full dependency graph in the renderer.
 */
export function startupInstallArgs(): string[] {
  return ['install'];
}
