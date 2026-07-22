import type { WebContainer } from '@webcontainer/api';

const WEBCONTAINER_PNPM_VERSION = '11.14.0';

const NPM_REGISTRY = 'https://registry.npmjs.org/';
const PNPM_CONFIG_ROOT = '.ghostbuild/pnpm-config';
const PNPM_CONFIG_DIRECTORY = `${PNPM_CONFIG_ROOT}/pnpm`;
const PNPM_CONFIG_FILE = `${PNPM_CONFIG_DIRECTORY}/config.yaml`;

/**
 * pnpm 11 expects its user configuration file to exist in WebContainer. Keep
 * that managed file inside the project-visible filesystem because absolute
 * paths written through the WebContainer FS API do not necessarily address
 * the same root observed by spawned processes.
 */
export async function prepareWebContainerPnpm(container: Pick<WebContainer, 'fs'>): Promise<void> {
  await container.fs.mkdir(PNPM_CONFIG_DIRECTORY, { recursive: true });
  await container.fs.writeFile(PNPM_CONFIG_FILE, '{}\n');
}

export function webContainerPnpmEnvironment(container: Pick<WebContainer, 'workdir'>): Record<string, string> {
  return { XDG_CONFIG_HOME: `${container.workdir}/${PNPM_CONFIG_ROOT}` };
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
