import { describe, expect, test, vi } from 'vitest';
import { MANAGED_WEBCONTAINER_NPMRC_CONTENT } from '~/utils/secretFiles';
import { prepareWebContainerNpm, webContainerNpmEnvironment } from './npm';

describe('WebContainer npm', () => {
  test('creates managed project configuration', async () => {
    const writeFile = vi.fn();

    await prepareWebContainerNpm({ fs: { writeFile } } as never);

    expect(writeFile).toHaveBeenCalledWith('.npmrc', MANAGED_WEBCONTAINER_NPMRC_CONTENT);
  });

  test('uses the public registry without lifecycle scripts', () => {
    expect(webContainerNpmEnvironment()).toEqual({
      CI: 'true',
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_registry: 'https://registry.npmjs.org/',
    });
  });
});
