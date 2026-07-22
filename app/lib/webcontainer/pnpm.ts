const WEBCONTAINER_PNPM_VERSION = '11.14.0';

const NPM_REGISTRY = 'https://registry.npmjs.org/';

/**
 * WebContainer's preinstalled pnpm can lag behind the lockfile version used by
 * generated projects. Execute the reviewed project version through npm's
 * package runner instead of relying on that ambient binary.
 */
export function webContainerPnpmCommand(args: string[]): string[] {
  return [
    'npx',
    '--yes',
    '--ignore-scripts',
    `--registry=${NPM_REGISTRY}`,
    `--package=pnpm@${WEBCONTAINER_PNPM_VERSION}`,
    '--',
    'pnpm',
    ...args,
  ];
}
