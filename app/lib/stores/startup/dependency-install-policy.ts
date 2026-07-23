const NPM_REGISTRY = 'https://registry.npmjs.org/';

/**
 * Restored snapshots are untrusted project data. Dependency resolution is
 * registry-bound, project pnpm hooks are disabled, and no lifecycle scripts
 * execute merely because a user opens or restores a project.
 */
export function startupInstallArgs(): string[] {
  return ['install', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`];
}
