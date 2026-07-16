import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildDeploymentPlan, buildDeploymentPlanFromSource, deploymentPlanResourceName } from './deployment-plan';

describe('buildDeploymentPlan', () => {
  it('binds the user-account billing policy and source digest into an immutable plan', async () => {
    const result = await buildDeploymentPlan({
      deploymentId: 'deployment-1',
      snapshot: await webSnapshot('source'),
    });

    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plan.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plan.project?.type).toBe('web_app');
    expect(result.plan.billing).toEqual({
      infrastructure: 'user_cloudflare_account',
      workersAi: 'user_cloudflare_account',
      workersPaidUpgrade: 'explicit_user_authorization_required',
    });
    expect(result.plan.resources.map(({ type }) => type)).toEqual([
      'worker',
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

  it('plans only the resources configured by a Worker-only project', async () => {
    const zip = new JSZip();
    zip.file('package.json', JSON.stringify({ ghostbuild: { projectType: 'worker' } }));
    zip.file('wrangler.jsonc', JSON.stringify({ main: 'src/server.ts', ...runtimeConfig(), ai: { binding: 'AI' } }));
    zip.file('src/server.ts', "export default { fetch: () => new Response('ok') };\n");
    const result = await buildDeploymentPlan({ deploymentId: 'deployment-1', snapshot: await zipBlob(zip) });
    expect(result.plan.project).toEqual({
      type: 'worker',
      bindings: { ai: true, d1: false, r2: false, appAgent: false },
    });
    expect(result.plan.resources.map(({ type }) => type)).toEqual(['worker', 'workers_ai']);
  });

  it('rebuilds a fresh resource plan from an already verified source digest', async () => {
    const sourceSha256 = 'b'.repeat(64);
    const result = await buildDeploymentPlanFromSource({ deploymentId: 'deployment-2', sourceSha256 });

    expect(result.plan).toMatchObject({ deploymentId: 'deployment-2', sourceSha256 });
    expect(result.plan.resources[0]?.proposedName).toBe('ghostbuild-deployment-2');
    await expect(
      buildDeploymentPlanFromSource({ deploymentId: 'deployment-3', sourceSha256: 'invalid' }),
    ).rejects.toThrow('Deployment source digest is invalid.');
  });

  it('returns only one valid resource name for trusted provisioning', async () => {
    const { plan } = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-2',
      sourceSha256: 'b'.repeat(64),
    });
    expect(deploymentPlanResourceName(plan, 'worker', 'app')).toBe('ghostbuild-deployment-2');
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
  zip.file('package.json', JSON.stringify({ name: 'project', content }));
  zip.file(
    'wrangler.jsonc',
    JSON.stringify({
      main: 'src/server.ts',
      ...runtimeConfig(),
      ai: { binding: 'AI' },
      d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
      r2_buckets: [{ binding: 'APP_STORAGE' }],
      durable_objects: { bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['AppAgent'] }],
    }),
  );
  zip.file('src/server.ts', content);
  return zipBlob(zip);
}

function runtimeConfig() {
  return {
    compatibility_date: '2026-07-08',
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
