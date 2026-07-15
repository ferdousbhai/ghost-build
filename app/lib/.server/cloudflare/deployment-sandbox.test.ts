import { describe, expect, test, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  ContainerProxy: class ContainerProxy {},
  Sandbox: class Sandbox {},
}));

import { DeploymentSandbox } from './deployment-sandbox';

describe('DeploymentSandbox', () => {
  test('routes package downloads through the HTTPS host allowlist without enabling unrestricted internet', () => {
    const TestDeploymentSandbox = DeploymentSandbox as unknown as new () => DeploymentSandbox;
    const sandbox = new TestDeploymentSandbox();

    expect(sandbox.enableInternet).toBe(false);
    expect(sandbox.interceptHttps).toBe(true);
    expect(sandbox.allowedHosts).toEqual(['registry.npmjs.org', 'api.cloudflare.com']);
  });
});
