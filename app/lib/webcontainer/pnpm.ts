import type { WebContainer } from '@webcontainer/api';
import { MANAGED_WEBCONTAINER_NPMRC_CONTENT } from '~/utils/secretFiles';

const WEBCONTAINER_PNPM_VERSION = '9.15.9';

const NPM_REGISTRY = 'https://registry.npmjs.org/';
const PNPM_CONFIG_ROOT = '.ghostbuild/pnpm-config';
const PNPM_CONFIG_DIRECTORY = `${PNPM_CONFIG_ROOT}/pnpm`;
const PNPM_CONFIG_FILE = `${PNPM_CONFIG_DIRECTORY}/config.yaml`;
const PROJECT_NPMRC_FILE = '.npmrc';

/**
 * Browser package managers probe project and user configuration paths while
 * starting. Keep their managed, credential-free files in the project-visible
 * filesystem because absolute paths written through the WebContainer FS API
 * do not necessarily address the same root observed by spawned processes.
 */
export async function prepareWebContainerPackageManagers(container: Pick<WebContainer, 'fs'>): Promise<void> {
  await container.fs.mkdir(PNPM_CONFIG_DIRECTORY, { recursive: true });
  await container.fs.writeFile(PNPM_CONFIG_FILE, '{}\n');
  // Avoid an optional-config read race with the secret-file watcher.
  await container.fs.writeFile(PROJECT_NPMRC_FILE, MANAGED_WEBCONTAINER_NPMRC_CONTENT);
}

export function webContainerNpmEnvironment(): Record<string, string> {
  return { CI: 'true' };
}

export function webContainerPnpmEnvironment(container: Pick<WebContainer, 'workdir'>): Record<string, string> {
  return {
    XDG_CONFIG_HOME: `${container.workdir}/${PNPM_CONFIG_ROOT}`,
    ...webContainerNpmEnvironment(),
    // Keep the browser-only pnpm pinned even when packageManager names the
    // newer version used by production builds.
    npm_config_manage_package_manager_versions: 'false',
  };
}

/**
 * WebContainer's preinstalled pnpm can lag behind the lockfile version used by
 * generated projects. Pin the smallest major that reads the v9 lockfile:
 * pnpm 11's SQLite store requires Node APIs that WebContainer does not
 * implement, and pnpm 9 avoids the heavier pnpm 10 cold-install path.
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
