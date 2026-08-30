import { describe, expect, it } from 'vitest';
import {
  buildDeploymentPlanFromSource,
  deploymentPlanResourceName,
  isCurrentDeploymentPlan,
  parseDeploymentPlanJson,
} from './deployment-plan';
import { DEPLOYMENT_SECURITY_BASELINE_VERSION } from './deployment-security-baseline';
import { appDeploymentIdFromResourceName } from '~/lib/cloudflare/app-resource-names';

const SOURCE_ONE = '1'.repeat(64);
const SOURCE_TWO = '2'.repeat(64);

describe('buildDeploymentPlanFromSource', () => {
  it('binds the exact revision and resource intent into an immutable plan', async () => {
    const result = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_ONE,
      project: { type: 'web_app', bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true } },
    });

    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plan).toMatchObject({
      version: 5,
      sourceSha256: SOURCE_ONE,
      templateSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
    });
    expect(result.plan.resources.map(({ type }) => type)).toEqual([
      'worker',
      'd1',
      'd1',
      'd1',
      'd1',
      'r2',
      'kv',
      'durable_object',
      'workers_ai',
    ]);
  });

  it('changes the plan digest when the exact backup revision changes', async () => {
    const project = { type: 'web_app' as const, bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true } };
    const first = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_ONE,
      project,
    });
    const second = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_TWO,
      project,
    });
    expect(first.digest).not.toBe(second.digest);
  });

  it('plans only resources declared by a Worker without ambient AI access', async () => {
    const result = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_ONE,
      project: { type: 'worker', bindings: { ai: false, d1: false, r2: false, kv: false, appAgent: false } },
    });
    expect(result.plan.resources.map(({ type }) => type)).toEqual(['worker']);
  });

  it('returns only one valid resource name for trusted provisioning', async () => {
    const { plan } = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-2',
      sourceSha256: SOURCE_ONE,
      project: { type: 'web_app', bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true } },
    });
    expect(deploymentPlanResourceName(plan, 'worker', 'app')).toBe('ghostbuild-deployment-2');
    expect(deploymentPlanResourceName(plan, 'd1', 'DB_PREVIEW')).toBe('ghostbuild-deployment-2-preview');
    expect(deploymentPlanResourceName(plan, 'd1', 'AGENT_SECURITY_DB')).toBe('ghostbuild-deployment-2-agent-security');
    expect(deploymentPlanResourceName(plan, 'd1', 'AGENT_SECURITY_DB_PREVIEW')).toBe(
      'ghostbuild-deployment-2-preview-agent',
    );
    expect(deploymentPlanResourceName(plan, 'workers_ai', 'AI')).toBe('AI');
    expect(deploymentPlanResourceName(plan, 'durable_object', 'AppAgent')).toBe('AppAgent');
    expect(
      deploymentPlanResourceName(
        { ...plan, resources: [...plan.resources, { ...plan.resources[0] }] },
        'worker',
        'app',
      ),
    ).toBeNull();
  });

  it('rejects a source reference that is not an exact SHA-256 revision', async () => {
    await expect(
      buildDeploymentPlanFromSource({
        deploymentId: 'deployment-1',
        sourceSha256: 'latest',
        project: { type: 'worker', bindings: { ai: false, d1: false, r2: false, kv: false, appAgent: false } },
      }),
    ).rejects.toThrow('Deployment source digest is invalid.');
  });

  it('rejects persisted plans without a complete project profile', async () => {
    const { plan } = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: SOURCE_ONE,
      project: { type: 'worker', bindings: { ai: false, d1: false, r2: false, kv: false, appAgent: false } },
    });
    const { project: _project, ...missingProject } = plan;

    expect(parseDeploymentPlanJson(JSON.stringify(plan))).toEqual(plan);
    expect(isCurrentDeploymentPlan(plan)).toBe(true);
    expect(isCurrentDeploymentPlan(missingProject)).toBe(false);
    expect(() => parseDeploymentPlanJson(JSON.stringify(missingProject))).toThrow();
    expect(() =>
      parseDeploymentPlanJson(JSON.stringify({ ...plan, project: { type: 'worker', bindings: { ai: false } } })),
    ).toThrow();
  });
});

/** Account resources are named after their deployment; Durable Objects and AI are binding classes. */
const ACCOUNT_RESOURCE_TYPES = new Set(['worker', 'd1', 'r2', 'kv']);
const BINDING_FLAGS = ['ai', 'd1', 'r2', 'kv', 'appAgent'] as const;

describe('app resource names round-trip through reconciliation', () => {
  const DEPLOYMENT = 'd6738251-57e1-4d83-9589-1b6c6d982417';

  it.each(['web_app', 'worker'] as const)(
    'recovers the deployment id from every %s resource a plan can contain',
    async (type) => {
      for (let mask = 0; mask < 1 << BINDING_FLAGS.length; mask += 1) {
        const bindings = Object.fromEntries(
          BINDING_FLAGS.map((flag, index) => [flag, Boolean(mask & (1 << index))]),
        ) as Record<(typeof BINDING_FLAGS)[number], boolean>;
        const { plan } = await buildDeploymentPlanFromSource({
          deploymentId: DEPLOYMENT,
          sourceSha256: SOURCE_ONE,
          project: { type, bindings },
        });

        for (const resource of plan.resources.filter((candidate) => ACCOUNT_RESOURCE_TYPES.has(candidate.type))) {
          // A binding added without teaching the name parser fails here, not in a live sweep.
          expect(appDeploymentIdFromResourceName(resource.proposedName)).toBe(plan.deploymentId);
        }
      }
    },
  );
});
