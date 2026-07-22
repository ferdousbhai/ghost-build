import type { WebContainer } from '@webcontainer/api';

const WEBCONTAINER_PNPM_VERSION = '10.34.0';

const NPM_REGISTRY = 'https://registry.npmjs.org/';
const PNPM_CONFIG_ROOT = '.ghostbuild/pnpm-config';
const PNPM_CONFIG_DIRECTORY = `${PNPM_CONFIG_ROOT}/pnpm`;
const PNPM_CONFIG_FILE = `${PNPM_CONFIG_DIRECTORY}/config.yaml`;
const PROJECT_NPMRC_FILE = '.npmrc';

/**
 * pnpm 11 expects its user configuration file to exist in WebContainer. Keep
 * that managed file inside the project-visible filesystem because absolute
 * paths written through the WebContainer FS API do not necessarily address
 * the same root observed by spawned processes.
 */
export async function prepareWebContainerPnpm(container: Pick<WebContainer, 'fs'>): Promise<void> {
  await container.fs.mkdir(PNPM_CONFIG_DIRECTORY, { recursive: true });
  await container.fs.writeFile(PNPM_CONFIG_FILE, '{}\n');
  // WebContainer's Node 22 filesystem shim reports a missing project npmrc as
  // a fatal read error to pnpm 10 instead of treating it as optional.
  await container.fs.writeFile(PROJECT_NPMRC_FILE, '');
}

export function webContainerPnpmEnvironment(container: Pick<WebContainer, 'workdir'>): Record<string, string> {
  return {
    XDG_CONFIG_HOME: `${container.workdir}/${PNPM_CONFIG_ROOT}`,
    // pnpm 10 otherwise honors packageManager and replaces itself with pnpm 11.
    npm_config_manage_package_manager_versions: 'false',
  };
}

/**
 * WebContainer's preinstalled pnpm can lag behind the lockfile version used by
 * generated projects. Pin the latest Node 22-compatible major here: pnpm 11's
 * SQLite store requires Node APIs that WebContainer does not implement, while
 * pnpm 10 reads the same v9 lockfile used by generated projects.
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
