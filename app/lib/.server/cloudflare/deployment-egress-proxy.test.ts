import { describe, expect, test } from 'vitest';
import { isApprovedCloudflareApiRequest } from './deployment-egress-proxy';

const account = 'account-1';
const plan = {
  resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-deployment-1' }],
};
const resources = [
  { resourceType: 'd1', logicalName: 'DB', providerResourceId: 'd1-id' },
  { resourceType: 'r2', logicalName: 'APP_STORAGE', providerResourceId: 'ghostbuild-deployment-1-storage' },
];

describe('deployment Cloudflare API allowlist', () => {
  test('allows only exact approved Worker and D1 deployment operations', () => {
    expect(allowed('PUT', `/accounts/${account}/workers/scripts/ghostbuild-deployment-1`)).toBe(true);
    expect(allowed('POST', `/accounts/${account}/d1/database/d1-id/query`)).toBe(true);
    expect(allowed('POST', `/accounts/${account}/workers/scripts/ghostbuild-deployment-1/assets-upload-session`)).toBe(
      true,
    );
    expect(allowed('GET', `/accounts/${account}/r2/buckets`)).toBe(true);
  });

  test('denies other accounts, resources, deletion, and every billing or subscription mutation', () => {
    expect(allowed('PUT', '/accounts/another/workers/scripts/ghostbuild-deployment-1')).toBe(false);
    expect(allowed('PUT', `/accounts/${account}/workers/scripts/unapproved-worker`)).toBe(false);
    expect(allowed('POST', `/accounts/${account}/d1/database/another-id/query`)).toBe(false);
    expect(allowed('POST', `/accounts/${account}/d1/database/d1-id/export`)).toBe(false);
    expect(allowed('POST', `/accounts/${account}/d1/database/d1-id/import`)).toBe(false);
    expect(allowed('DELETE', `/accounts/${account}/workers/scripts/ghostbuild-deployment-1`)).toBe(false);
    expect(allowed('POST', `/accounts/${account}/subscriptions`)).toBe(false);
    expect(allowed('PUT', `/accounts/${account}/workers/subdomain`)).toBe(false);
    expect(allowed('GET', `/accounts/${account}/billing/profile`)).toBe(false);
  });

  test('denies non-Cloudflare and non-HTTPS destinations', () => {
    expect(
      isApprovedCloudflareApiRequest(
        'PUT',
        new URL(`https://attacker.example/client/v4/accounts/${account}/workers/scripts/ghostbuild-deployment-1`),
        account,
        plan,
        resources,
      ),
    ).toBe(false);
    expect(
      isApprovedCloudflareApiRequest(
        'PUT',
        new URL(`http://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/ghostbuild-deployment-1`),
        account,
        plan,
        resources,
      ),
    ).toBe(false);
  });
});

function allowed(method: string, path: string): boolean {
  return isApprovedCloudflareApiRequest(
    method,
    new URL(`https://api.cloudflare.com/client/v4${path}`),
    account,
    plan,
    resources,
  );
}
