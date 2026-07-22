import { describe, expect, test } from 'vitest';
import {
  createDeploymentProxyToken,
  deploymentPublishContainerId,
  DeploymentProxyTokenError,
  parseDeploymentPublishContainerId,
  verifyDeploymentProxyToken,
} from './deployment-proxy-token';

const secret = btoa('0123456789abcdef0123456789abcdef');
const deploymentId = '11111111-2222-4333-8444-555555555555';

describe('deployment proxy tokens', () => {
  test('binds a short-lived token to the deployment, account, plan, and sandbox', async () => {
    const token = await createDeploymentProxyToken({
      secretBase64: secret,
      deploymentId: 'deployment-1',
      accountId: 'account-1',
      connectionGeneration: 3,
      executionGeneration: 7,
      planDigest: 'a'.repeat(64),
      containerId: 'publish-deployment-1',
      nowSeconds: 100,
    });

    await expect(
      verifyDeploymentProxyToken({
        token,
        secretBase64: secret,
        expectedContainerId: 'publish-deployment-1',
        nowSeconds: 200,
      }),
    ).resolves.toMatchObject({
      deploymentId: 'deployment-1',
      accountId: 'account-1',
      connectionGeneration: 3,
      executionGeneration: 7,
    });
  });

  test('rejects tampering, expiration, and use by another sandbox', async () => {
    const token = await createDeploymentProxyToken({
      secretBase64: secret,
      deploymentId: 'deployment-1',
      accountId: 'account-1',
      connectionGeneration: 3,
      executionGeneration: 7,
      planDigest: 'a'.repeat(64),
      containerId: 'publish-deployment-1',
      nowSeconds: 100,
      lifetimeSeconds: 60,
    });

    await expect(
      verifyDeploymentProxyToken({
        token: `${token.slice(0, -1)}x`,
        secretBase64: secret,
        expectedContainerId: 'publish-deployment-1',
        nowSeconds: 120,
      }),
    ).rejects.toBeInstanceOf(DeploymentProxyTokenError);
    await expect(
      verifyDeploymentProxyToken({
        token,
        secretBase64: secret,
        expectedContainerId: 'another-sandbox',
        nowSeconds: 120,
      }),
    ).rejects.toBeInstanceOf(DeploymentProxyTokenError);
    await expect(
      verifyDeploymentProxyToken({
        token,
        secretBase64: secret,
        expectedContainerId: 'publish-deployment-1',
        nowSeconds: 160,
      }),
    ).rejects.toBeInstanceOf(DeploymentProxyTokenError);
  });

  test('uses a reversible generation-specific container ID within the Sandbox SDK limit', () => {
    const containerId = deploymentPublishContainerId({
      deploymentId,
      connectionGeneration: Number.MAX_SAFE_INTEGER,
      executionGeneration: Number.MAX_SAFE_INTEGER,
    });

    expect(containerId.length).toBeLessThanOrEqual(63);
    expect(containerId).toMatch(/^[a-z0-9-]+$/);
    expect(parseDeploymentPublishContainerId(containerId)).toEqual({
      deploymentId,
      connectionGeneration: Number.MAX_SAFE_INTEGER,
      executionGeneration: Number.MAX_SAFE_INTEGER,
    });
  });
});
