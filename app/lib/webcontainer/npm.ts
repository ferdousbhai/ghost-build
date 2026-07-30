import type { WebContainer } from '@webcontainer/api';
import { MANAGED_WEBCONTAINER_NPMRC_CONTENT } from '~/utils/secretFiles';

const NPM_REGISTRY = 'https://registry.npmjs.org/';
const PROJECT_NPMRC_FILE = '.npmrc';

/**
 * Keep npm's managed, credential-free configuration in the project-visible
 * filesystem so installs cannot inherit a user registry or lifecycle policy.
 */
export async function prepareWebContainerNpm(container: Pick<WebContainer, 'fs'>): Promise<void> {
  await container.fs.writeFile(PROJECT_NPMRC_FILE, MANAGED_WEBCONTAINER_NPMRC_CONTENT);
}

export function webContainerNpmEnvironment(): Record<string, string> {
  return {
    CI: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_registry: NPM_REGISTRY,
  };
}
