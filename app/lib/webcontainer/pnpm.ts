import type { WebContainer } from '@webcontainer/api';

const WEBCONTAINER_PNPM_VERSION = '11.14.0';

const NPM_REGISTRY = 'https://registry.npmjs.org/';
const PNPM_CONFIG_DIRECTORY = '/home/.config/pnpm';

/**
 * pnpm 11 reads its user configuration from /home/.config/pnpm in
 * WebContainer. Fresh containers do not always include that directory, and
 * pnpm treats the missing parent as a fatal ENOENT instead of an empty config.
 */
export async function prepareWebContainerPnpm(container: Pick<WebContainer, 'fs'>): Promise<void> {
  await container.fs.mkdir(PNPM_CONFIG_DIRECTORY, { recursive: true });
}

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
