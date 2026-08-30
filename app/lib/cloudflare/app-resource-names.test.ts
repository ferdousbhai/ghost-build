import { describe, expect, it } from 'vitest';
import { appDeploymentIdFromResourceName, appResourceName } from './app-resource-names';

const DEPLOYMENT = 'd6738251-57e1-4d83-9589-1b6c6d982417';

describe('app resource naming', () => {
  it('composes every logical binding onto the deployment id', () => {
    expect(appResourceName(DEPLOYMENT, 'app')).toBe(`ghostbuild-${DEPLOYMENT}`);
    expect(appResourceName(DEPLOYMENT, 'DB')).toBe(`ghostbuild-${DEPLOYMENT}`);
    expect(appResourceName(DEPLOYMENT, 'DB_PREVIEW')).toBe(`ghostbuild-${DEPLOYMENT}-preview`);
    expect(appResourceName(DEPLOYMENT, 'AGENT_SECURITY_DB')).toBe(`ghostbuild-${DEPLOYMENT}-agent-security`);
    expect(appResourceName(DEPLOYMENT, 'AGENT_SECURITY_DB_PREVIEW')).toBe(`ghostbuild-${DEPLOYMENT}-preview-agent`);
    expect(appResourceName(DEPLOYMENT, 'APP_STORAGE')).toBe(`ghostbuild-${DEPLOYMENT}-storage`);
    expect(appResourceName(DEPLOYMENT, 'APP_CACHE')).toBe(`ghostbuild-${DEPLOYMENT}-cache`);
  });
});

describe('app deployment id recovery', () => {
  it('recovers the deployment id from every app resource suffix', () => {
    expect(appDeploymentIdFromResourceName(`ghostbuild-${DEPLOYMENT}`)).toBe(DEPLOYMENT);
    expect(appDeploymentIdFromResourceName(`ghostbuild-${DEPLOYMENT}-preview`)).toBe(DEPLOYMENT);
    expect(appDeploymentIdFromResourceName(`ghostbuild-${DEPLOYMENT}-agent-security`)).toBe(DEPLOYMENT);
    expect(appDeploymentIdFromResourceName(`ghostbuild-${DEPLOYMENT}-preview-agent`)).toBe(DEPLOYMENT);
    expect(appDeploymentIdFromResourceName(`ghostbuild-${DEPLOYMENT}-storage`)).toBe(DEPLOYMENT);
    expect(appDeploymentIdFromResourceName(`ghostbuild-${DEPLOYMENT}-cache`)).toBe(DEPLOYMENT);
  });

  it('refuses every prefixed resource that is not a UUID deployment', () => {
    // Workspace runtimes and their databases are live infrastructure with a separate lifecycle.
    expect(appDeploymentIdFromResourceName('ghostbuild-workspace-18e073433e6fad63')).toBeNull();
    expect(appDeploymentIdFromResourceName('ghostbuild-data-18e073433e6fad63')).toBeNull();
    expect(appDeploymentIdFromResourceName('ghostbuild-builder-skills')).toBeNull();
    expect(appDeploymentIdFromResourceName('ghostbuild-ops')).toBeNull();
    expect(appDeploymentIdFromResourceName('ghostbuild')).toBeNull();
    expect(appDeploymentIdFromResourceName('summonghost-avatars')).toBeNull();
  });
});
