import { describe, expect, it } from 'vitest';
import {
  PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
  PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES,
} from './project-workspace-container-policy';

/**
 * Cloudflare instance types reviewed for the Computer workspace runtime. A tier
 * outside this set has never been sized against Ghostbuild's install, typecheck,
 * build, validation, and preview workloads and must not reach an account.
 */
const REVIEWED_INSTANCE_TYPES = ['basic', 'standard-1', 'standard-2'] as const;

describe('ProjectWorkspace container policy', () => {
  it('selects one reviewed Cloudflare instance type', () => {
    expect(REVIEWED_INSTANCE_TYPES).toContain(PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE);
  });

  it('caps concurrent workspace containers at a reviewed launch ceiling', () => {
    expect(Number.isInteger(PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES)).toBe(true);
    expect(PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES).toBeGreaterThan(0);
    expect(PROJECT_WORKSPACE_CONTAINER_MAX_INSTANCES).toBeLessThanOrEqual(10);
  });
});
