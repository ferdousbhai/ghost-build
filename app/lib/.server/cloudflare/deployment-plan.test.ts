import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDeploymentPlan, deploymentPlanResourceName } from './deployment-plan';
import { APP_AGENT_PROTECTED_FILE_SHA256, DEPLOYMENT_SECURITY_BASELINE_VERSION } from './deployment-security-baseline';

describe('buildDeploymentPlan', () => {
  it('binds the user-account billing policy and source digest into an immutable plan', async () => {
    const result = await buildDeploymentPlan({
      deploymentId: 'deployment-1',
      snapshot: await webSnapshot('source'),
    });

    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plan.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plan).toMatchObject({
      version: 2,
      templateSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
    });
    expect(result.plan.project?.type).toBe('web_app');
    expect(result.plan.billing).toEqual({
      infrastructure: 'user_cloudflare_account',
      workersAi: 'user_cloudflare_account',
      workersPaidUpgrade: 'explicit_user_authorization_required',
    });
    expect(result.plan.resources.map(({ type }) => type)).toEqual([
      'worker',
      'd1',
      'd1',
      'r2',
      'durable_object',
      'workers_ai',
    ]);
  });

  it('changes the approval digest when the source changes', async () => {
    const first = await buildDeploymentPlan({ deploymentId: 'deployment-1', snapshot: await webSnapshot('one') });
    const second = await buildDeploymentPlan({ deploymentId: 'deployment-1', snapshot: await webSnapshot('two') });
    expect(first.digest).not.toBe(second.digest);
  });

  it('plans only the resources configured by a Worker without ambient AI access', async () => {
    const zip = new JSZip();
    zip.file('package.json', JSON.stringify({ ghostbuild: { projectType: 'worker' } }));
    zip.file('wrangler.jsonc', JSON.stringify({ main: 'src/server.ts', ...runtimeConfig() }));
    zip.file('src/server.ts', "export default { fetch: () => new Response('ok') };\n");
    const result = await buildDeploymentPlan({ deploymentId: 'deployment-1', snapshot: await zipBlob(zip) });
    expect(result.plan.project).toEqual({
      type: 'worker',
      bindings: { ai: false, d1: false, r2: false, appAgent: false },
    });
    expect(result.plan.resources.map(({ type }) => type)).toEqual(['worker']);
  });

  it('returns only one valid resource name for trusted provisioning', async () => {
    const { plan } = await buildDeploymentPlan({
      deploymentId: 'deployment-2',
      snapshot: await webSnapshot('resource validation'),
    });
    expect(deploymentPlanResourceName(plan, 'worker', 'app')).toBe('ghostbuild-deployment-2');
    expect(deploymentPlanResourceName(plan, 'd1', 'AGENT_SECURITY_DB')).toBe('ghostbuild-deployment-2-agent-security');
    expect(deploymentPlanResourceName(plan, 'workers_ai', 'AI')).toBe('AI');
    expect(deploymentPlanResourceName(plan, 'durable_object', 'AppAgent')).toBe('AppAgent');
    expect(
      deploymentPlanResourceName(
        { ...plan, resources: [...plan.resources, { ...plan.resources[0]! }] },
        'worker',
        'app',
      ),
    ).toBeNull();
  });
});

async function webSnapshot(content: string): Promise<Blob> {
  const zip = new JSZip();
  const pkg = JSON.parse(readFileSync('template/package.json', 'utf8')) as Record<string, unknown>;
  zip.file('package.json', JSON.stringify({ ...pkg, ghostbuildTestContent: content }));
  zip.file(
    'wrangler.jsonc',
    JSON.stringify({
      main: 'src/server.ts',
      ...runtimeConfig(),
      ai: { binding: 'AI' },
      d1_databases: [
        { binding: 'DB', migrations_dir: 'migrations' },
        { binding: 'AGENT_SECURITY_DB', migrations_dir: 'agent-security-migrations' },
      ],
      r2_buckets: [{ binding: 'APP_STORAGE' }],
      durable_objects: { bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] },
      exports: { AppAgent: { type: 'durable-object', storage: 'sqlite' } },
      triggers: { crons: ['0 3 * * *'] },
    }),
  );
  addProtectedSecurityFiles(zip);
  return zipBlob(zip);
}

function addProtectedSecurityFiles(zip: JSZip): void {
  for (const path of Object.keys(APP_AGENT_PROTECTED_FILE_SHA256)) {
    zip.file(path, readFileSync(`template/${path}`, 'utf8'));
  }
  zip.file('pnpm-lock.yaml', readFileSync('template/pnpm-lock.yaml', 'utf8'));
}

function runtimeConfig() {
  return {
    compatibility_date: '2026-07-18',
    compatibility_flags: ['nodejs_compat'],
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 0.6 },
      traces: { enabled: true, head_sampling_rate: 0.05 },
    },
    upload_source_maps: true,
  };
}

async function zipBlob(zip: JSZip): Promise<Blob> {
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return new Blob([owned.buffer], { type: 'application/zip' });
}
