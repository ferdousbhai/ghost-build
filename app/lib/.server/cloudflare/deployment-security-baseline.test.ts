import { describe, expect, test } from 'vitest';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
  isCurrentDeploymentSecurityIdentity,
} from './deployment-security-baseline';

const current = {
  version: 5,
  templateSourceSha256: TEMPLATE_SOURCE_SHA256,
  securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
  securityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
};

describe('deployment security identity', () => {
  test('accepts a deployment carrying exactly the current identity', () => {
    expect(isCurrentDeploymentSecurityIdentity(current)).toBe(true);
  });

  test.each([
    ['version', { version: 4 }],
    ['template source', { templateSourceSha256: `${'0'.repeat(64)}` }],
    ['baseline version', { securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION - 1 }],
    ['security boundary', { securityBoundarySha256: `${'0'.repeat(64)}` }],
  ])('fails closed when the %s differs', (_case, override) => {
    expect(isCurrentDeploymentSecurityIdentity({ ...current, ...override })).toBe(false);
  });

  test('fails closed on an empty readback', () => {
    expect(isCurrentDeploymentSecurityIdentity({})).toBe(false);
  });
});
