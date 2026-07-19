import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { inspectDeploymentSnapshot, MAX_DEPLOYMENT_EXPANDED_BYTES } from './deployment-snapshot';

describe('inspectDeploymentSnapshot', () => {
  it('detects an explicit Worker-only profile and its configured bindings', async () => {
    const snapshot = await projectZip({ projectType: 'worker', includeBindings: false });
    await expect(inspectDeploymentSnapshot(snapshot)).resolves.toEqual({
      type: 'worker',
      bindings: { ai: false, d1: false, r2: false, appAgent: false },
    });
  });

  it('defaults the template profile to a web application', async () => {
    const snapshot = await projectZip({ includeBindings: true });
    await expect(inspectDeploymentSnapshot(snapshot)).resolves.toEqual({
      type: 'web_app',
      bindings: { ai: true, d1: true, r2: true, appAgent: true },
    });
  });

  it('rejects unsafe paths and expanded archives above the production limit', async () => {
    const unsafe = new JSZip();
    unsafe.file('../package.json', '{}');
    unsafe.file('wrangler.jsonc', '{"main":"src/server.ts"}');
    await expect(inspectDeploymentSnapshot(await asBlob(unsafe))).rejects.toThrow('unsafe file path');

    const oversized = new Uint8Array(
      await (await projectZip({ projectType: 'worker', includeBindings: false })).arrayBuffer(),
    );
    setCentralDirectoryUncompressedSize(oversized, 'src/server.ts', MAX_DEPLOYMENT_EXPANDED_BYTES + 1);
    await expect(inspectDeploymentSnapshot(new Blob([oversized]))).rejects.toThrow('250 MiB');
  });

  it('rejects credential-bearing local configuration in a directly submitted snapshot', async () => {
    const zip = new JSZip();
    zip.file('package.json', JSON.stringify({ ghostbuild: { projectType: 'worker' } }));
    zip.file(
      'wrangler.jsonc',
      JSON.stringify({
        main: 'src/server.ts',
        compatibility_date: '2026-07-18',
        compatibility_flags: ['nodejs_compat'],
        observability: {
          enabled: true,
          logs: { enabled: true, head_sampling_rate: 0.6 },
          traces: { enabled: true, head_sampling_rate: 0.05 },
        },
        upload_source_maps: true,
      }),
    );
    zip.file('src/server.ts', "export default { fetch: () => new Response('ok') };\n");
    zip.file('.npmrc', '//registry.npmjs.org/:_authToken=secret');

    await expect(inspectDeploymentSnapshot(await asBlob(zip))).rejects.toThrow('local secret file');

    zip.remove('.npmrc');
    zip.file('nested/.git/config', 'url = https://user:token@example.com/repo.git');
    await expect(inspectDeploymentSnapshot(await asBlob(zip))).rejects.toThrow('local secret file');
  });

  it('bounds metadata inflation even when ZIP headers understate the expanded size', async () => {
    const zip = new JSZip();
    zip.file('package.json', JSON.stringify({ padding: 'a'.repeat(1024 * 1024) }));
    zip.file('wrangler.jsonc', JSON.stringify({ main: 'src/server.ts' }));
    const deceptive = new Uint8Array(await (await asBlob(zip)).arrayBuffer());
    setCentralDirectoryUncompressedSize(deceptive, 'package.json', 1);

    await expect(inspectDeploymentSnapshot(new Blob([deceptive]))).rejects.toThrow('metadata size limit');
  });

  it('rejects Wrangler products that the trusted publisher cannot preserve', async () => {
    const zip = new JSZip();
    zip.file('package.json', JSON.stringify({ ghostbuild: { projectType: 'worker' } }));
    zip.file('wrangler.jsonc', JSON.stringify({ main: 'src/server.ts', queues: { consumers: [{ queue: 'jobs' }] } }));

    await expect(inspectDeploymentSnapshot(await asBlob(zip))).rejects.toThrow(
      'does not yet support wrangler.jsonc queues configuration',
    );
  });

  it('rejects runtime settings that the trusted publisher cannot preserve', async () => {
    const snapshot = await projectZip({
      projectType: 'worker',
      includeBindings: false,
      compatibilityDate: '2025-01-01',
    });
    await expect(inspectDeploymentSnapshot(snapshot)).rejects.toThrow('compatibility_date setting');
  });

  it('rejects binding semantics that the trusted publisher cannot preserve', async () => {
    const snapshot = await projectZip({
      includeBindings: true,
      appAgentClassName: 'OtherAgent',
    });
    await expect(inspectDeploymentSnapshot(snapshot)).rejects.toThrow('AppAgent Durable Object binding');
  });
});

async function projectZip(args: {
  projectType?: 'worker';
  includeBindings: boolean;
  compatibilityDate?: string;
  appAgentClassName?: string;
}): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    'package.json',
    JSON.stringify({ name: 'project', ...(args.projectType ? { ghostbuild: { projectType: args.projectType } } : {}) }),
  );
  zip.file(
    'wrangler.jsonc',
    JSON.stringify({
      main: 'src/server.ts',
      compatibility_date: args.compatibilityDate ?? '2026-07-18',
      compatibility_flags: ['nodejs_compat'],
      observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 0.6 },
        traces: { enabled: true, head_sampling_rate: 0.05 },
      },
      upload_source_maps: true,
      ...(args.includeBindings
        ? {
            ai: { binding: 'AI' },
            d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
            r2_buckets: [{ binding: 'APP_STORAGE' }],
            durable_objects: { bindings: [{ name: 'AppAgent', class_name: args.appAgentClassName ?? 'AppAgent' }] },
            exports: { AppAgent: { type: 'durable-object', storage: 'sqlite' } },
          }
        : {}),
    }),
  );
  zip.file('src/server.ts', "export default { fetch: () => new Response('ok') };\n");
  return asBlob(zip);
}

async function asBlob(zip: JSZip): Promise<Blob> {
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return new Blob([owned.buffer], { type: 'application/zip' });
}

function setCentralDirectoryUncompressedSize(bytes: Uint8Array, filename: string, size: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  for (let offset = 0; offset <= bytes.length - 46; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      continue;
    }
    const filenameLength = view.getUint16(offset + 28, true);
    const entryName = decoder.decode(bytes.subarray(offset + 46, offset + 46 + filenameLength));
    if (entryName === filename) {
      view.setUint32(offset + 24, size, true);
      return;
    }
  }
  throw new Error(`Unable to find ${filename} in ZIP central directory.`);
}
