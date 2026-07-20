import { describe, expect, test } from 'vitest';
import {
  createDeploymentProxyToken,
  DeploymentProxyTokenError,
  verifyDeploymentProxyToken,
} from './deployment-proxy-token';

const secret = btoa('0123456789abcdef0123456789abcdef');

describe('deployment proxy tokens', () => {
  test('binds a short-lived token to the deployment, account, plan, and sandbox', async () => {
    const token = await createDeploymentProxyToken({
      secretBase64: secret,
      deploymentId: 'deployment-1',
      accountId: 'account-1',
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
    ).resolves.toMatchObject({ deploymentId: 'deployment-1', accountId: 'account-1' });
  });

  test('rejects tampering, expiration, and use by another sandbox', async () => {
    const token = await createDeploymentProxyToken({
      secretBase64: secret,
      deploymentId: 'deployment-1',
      accountId: 'account-1',
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
});
