import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocument, stringify } from 'yaml';
import { inspectDeploymentSnapshot, MAX_DEPLOYMENT_EXPANDED_BYTES } from './deployment-snapshot';
import { APP_AGENT_PROTECTED_FILE_SHA256 } from './deployment-security-baseline';

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

  it('preflights the raw central-directory count before duplicate names can be collapsed', async () => {
    const source = new Uint8Array(
      await (await projectZip({ projectType: 'worker', includeBindings: false })).arrayBuffer(),
    );
    const duplicateFlood = repeatFirstCentralDirectoryEntry(source, 5_001);

    await expect(inspectDeploymentSnapshot(duplicateFlood.buffer)).rejects.toThrow(
      'must contain between 1 and 5000 entries',
    );
  });

  it('rejects ambiguous duplicate records and ZIP64 sentinels during raw archive preflight', async () => {
    const source = new Uint8Array(
      await (await projectZip({ projectType: 'worker', includeBindings: false })).arrayBuffer(),
    );
    await expect(inspectDeploymentSnapshot(repeatFirstCentralDirectoryEntry(source, 2).buffer)).rejects.toThrow(
      'ambiguous duplicate entries',
    );

    const zip64 = source.slice();
    const eocd = findEndOfCentralDirectory(zip64);
    new DataView(zip64.buffer).setUint16(eocd + 10, 0xffff, true);
    await expect(inspectDeploymentSnapshot(zip64.buffer)).rejects.toThrow('valid non-ZIP64 ZIP archive');
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

  it('rejects an ambient Workers AI binding without the reviewed AppAgent boundary', async () => {
    const zip = new JSZip();
    zip.file('package.json', JSON.stringify({ ghostbuild: { projectType: 'worker' } }));
    zip.file('wrangler.jsonc', JSON.stringify({ main: 'src/server.ts', ...runtimeConfig(), ai: { binding: 'AI' } }));
    zip.file('src/server.ts', "export default { fetch: () => new Response('ok') };\n");

    await expect(inspectDeploymentSnapshot(await asBlob(zip))).rejects.toThrow('unmediated Workers AI binding');
  });

  it('fails closed when an AppAgent security boundary file or cleanup trigger is changed', async () => {
    const changedFile = await projectZip({ includeBindings: true });
    const changedFileZip = await JSZip.loadAsync(await changedFile.arrayBuffer());
    changedFileZip.file('src/agent-security.ts', 'export const noSecurity = true;\n');
    await expect(inspectDeploymentSnapshot(await asBlob(changedFileZip))).rejects.toThrow(
      'differs from the reviewed deployment baseline',
    );

    await expect(
      inspectDeploymentSnapshot(await projectZip({ includeBindings: true, includeCleanupTrigger: false })),
    ).rejects.toThrow('security cleanup trigger');
  });

  it('requires the protected security database binding and exact migration directory', async () => {
    const missing = await projectZip({ includeBindings: true });
    const missingZip = await JSZip.loadAsync(await missing.arrayBuffer());
    const config = JSON.parse(await missingZip.file('wrangler.jsonc')!.async('string')) as {
      d1_databases: Array<{ binding?: string; migrations_dir?: string }>;
    };
    config.d1_databases = config.d1_databases.filter(
      (binding: { binding?: string }) => binding.binding !== 'AGENT_SECURITY_DB',
    );
    missingZip.file('wrangler.jsonc', JSON.stringify(config));
    await expect(inspectDeploymentSnapshot(await asBlob(missingZip))).rejects.toThrow('AGENT_SECURITY_DB');

    const wrongDirectory = await projectZip({ includeBindings: true });
    const wrongDirectoryZip = await JSZip.loadAsync(await wrongDirectory.arrayBuffer());
    const wrongConfig = JSON.parse(await wrongDirectoryZip.file('wrangler.jsonc')!.async('string')) as {
      d1_databases: Array<{ binding?: string; migrations_dir?: string }>;
    };
    const securityBinding = wrongConfig.d1_databases.find(
      (binding: { binding?: string }) => binding.binding === 'AGENT_SECURITY_DB',
    );
    expect(securityBinding).toBeDefined();
    securityBinding!.migrations_dir = 'migrations';
    wrongDirectoryZip.file('wrangler.jsonc', JSON.stringify(wrongConfig));
    await expect(inspectDeploymentSnapshot(await asBlob(wrongDirectoryZip))).rejects.toThrow('AGENT_SECURITY_DB');
  });

  it('rejects additional unreviewed migrations for the protected security database', async () => {
    const snapshot = await projectZip({ includeBindings: true });
    const zip = await JSZip.loadAsync(await snapshot.arrayBuffer());
    zip.file('agent-security-migrations/0002_unreviewed.sql', 'DROP TABLE app_agent_sessions;\n');

    await expect(inspectDeploymentSnapshot(await asBlob(zip))).rejects.toThrow(
      'only the reviewed agent security migrations',
    );
  });

  it('fails closed when the reviewed dependency lock identity changes', async () => {
    const snapshot = await projectZip({ includeBindings: true });
    const zip = await JSZip.loadAsync(await snapshot.arrayBuffer());
    const lock = await zip.file('pnpm-lock.yaml')!.async('string');
    zip.file('pnpm-lock.yaml', lock.replace('specifier: ^6.0.230', 'specifier: ^6.0.229'));

    await expect(inspectDeploymentSnapshot(await asBlob(zip))).rejects.toThrow(
      'changes the reviewed security or build toolchain',
    );
  });

  it('commits peer-qualified roots and every reachable lock snapshot edge', async () => {
    const snapshot = await projectZip({ includeBindings: true });
    const peerSubstitution = await JSZip.loadAsync(await snapshot.arrayBuffer());
    const peerLock = await peerSubstitution.file('pnpm-lock.yaml')!.async('string');
    peerSubstitution.file(
      'pnpm-lock.yaml',
      peerLock.replace(
        'version: 6.0.3(@rolldown/plugin-babel@0.2.3(@babel/core@8.0.1)',
        'version: 6.0.3(@rolldown/plugin-babel@0.2.3(@babel/core@7.29.7)',
      ),
    );
    await expect(inspectDeploymentSnapshot(await asBlob(peerSubstitution))).rejects.toThrow(
      'complete reviewed build toolchain',
    );

    const edgeSubstitution = await JSZip.loadAsync(await snapshot.arrayBuffer());
    const edgeLock = parseDocument(await edgeSubstitution.file('pnpm-lock.yaml')!.async('string')).toJS() as Record<
      string,
      any
    >;
    const viteVersion = edgeLock.importers['.'].devDependencies.vite.version as string;
    edgeLock.snapshots[`vite@${viteVersion}`].optionalDependencies.yaml = 'npm:jsonc-parser@3.3.1';
    edgeSubstitution.file('pnpm-lock.yaml', stringify(edgeLock));
    await expect(inspectDeploymentSnapshot(await asBlob(edgeSubstitution))).rejects.toThrow(
      'changes the reviewed security or build toolchain',
    );

    const patchedSubstitution = await JSZip.loadAsync(await snapshot.arrayBuffer());
    const patchedLock = parseDocument(
      await patchedSubstitution.file('pnpm-lock.yaml')!.async('string'),
    ).toJS() as Record<string, any>;
    patchedLock.patchedDependencies = { 'vite@8.1.5': 'patches/vite.patch' };
    patchedSubstitution.file('pnpm-lock.yaml', stringify(patchedLock));
    await expect(inspectDeploymentSnapshot(await asBlob(patchedSubstitution))).rejects.toThrow(
      'complete reviewed build toolchain',
    );
  });

  it.each(['jsonc-parser', 'yaml', 'globals', '@babel/core', 'zod'])(
    'requires the protected executable root %s',
    async (name) => {
      const snapshot = await projectZip({ includeBindings: true });
      const omittedRoot = await JSZip.loadAsync(await snapshot.arrayBuffer());
      const changedPackage = JSON.parse(await omittedRoot.file('package.json')!.async('string')) as Record<string, any>;
      const section = changedPackage.dependencies[name] === undefined ? 'devDependencies' : 'dependencies';
      changedPackage[section][name] = '0.0.0-unreviewed';
      omittedRoot.file('package.json', JSON.stringify(changedPackage));
      await expect(inspectDeploymentSnapshot(await asBlob(omittedRoot))).rejects.toThrow(
        `build dependency ${name} differs from the reviewed spec`,
      );
    },
  );

  it('permits unrelated application dependencies outside the protected toolchain closure', async () => {
    const snapshot = await projectZip({ includeBindings: true });
    const extended = await JSZip.loadAsync(await snapshot.arrayBuffer());
    const extendedPackage = JSON.parse(await extended.file('package.json')!.async('string')) as Record<string, any>;
    extendedPackage.dependencies['legitimate-app-package'] = '^1.0.0';
    extended.file('package.json', JSON.stringify(extendedPackage));
    const extendedLock = parseDocument(await extended.file('pnpm-lock.yaml')!.async('string')).toJS() as Record<
      string,
      any
    >;
    extendedLock.importers['.'].dependencies['legitimate-app-package'] = {
      specifier: '^1.0.0',
      version: '1.0.0',
    };
    extendedLock.packages['legitimate-app-package@1.0.0'] = {
      resolution: { integrity: 'sha512-legitimate-application-dependency' },
    };
    extendedLock.snapshots['legitimate-app-package@1.0.0'] = {};
    extended.file('pnpm-lock.yaml', stringify(extendedLock));
    await expect(inspectDeploymentSnapshot(await asBlob(extended))).resolves.toEqual({
      type: 'web_app',
      bindings: { ai: true, d1: true, r2: true, appAgent: true },
    });
  });

  it('rejects package import aliases and resolver overrides outside the reviewed mapping', async () => {
    const snapshot = await projectZip({ includeBindings: true });
    const aliased = await JSZip.loadAsync(await snapshot.arrayBuffer());
    const aliasedPackage = JSON.parse(await aliased.file('package.json')!.async('string')) as Record<string, unknown>;
    aliasedPackage.imports = { '#/*': './src/*', '#ambient': 'ambient-binding-package' };
    aliased.file('package.json', JSON.stringify(aliasedPackage));
    await expect(inspectDeploymentSnapshot(await asBlob(aliased))).rejects.toThrow('reviewed module type');

    const redirected = await JSZip.loadAsync(await snapshot.arrayBuffer());
    const redirectedPackage = JSON.parse(await redirected.file('package.json')!.async('string')) as Record<
      string,
      unknown
    >;
    redirectedPackage.browser = { './src/app-bindings.ts': './src/routes/unreviewed.ts' };
    redirected.file('package.json', JSON.stringify(redirectedPackage));
    await expect(inspectDeploymentSnapshot(await asBlob(redirected))).rejects.toThrow('resolver overrides');
  });

  it.each([
    `import { env } /* comment */ from 'cloudflare:workers';`,
    `void import/**/('cloudflare:workers');`,
    `void import('cloudflare:' + 'workers').then((module) => module.env['A' + 'I']);`,
    `const load = require /* comment */ ('cloudflare:' + 'workers');`,
    `const run = new Function('return 1');`,
    String.raw`import { env } from 'cloudflare:\x77orkers'; void env.AGENT_SECURITY_DB;`,
    String.raw`import { env } from 'cloudflare:\u0077orkers'; void env.AGENT_SECURITY_DB;`,
    String.raw`import { env } from 'cloudflare:\u{77}orkers'; void env.AGENT_SECURITY_DB;`,
    String.raw`globalThis['e\u0076al']('1');`,
    String.raw`new Funct\u0069on('return 1');`,
  ])('rejects an unprotected ambient binding import: %s', async (source) => {
    const snapshot = await projectZip({ includeBindings: true });
    const zip = await JSZip.loadAsync(await snapshot.arrayBuffer());
    zip.file('src/routes/unreviewed.ts', source);

    await expect(inspectDeploymentSnapshot(await asBlob(zip))).rejects.toThrow(
      'contains an unreviewed protected runtime binding access path',
    );
  });

  it('protects the reviewed Workers AI model identity', async () => {
    const snapshot = await projectZip({ includeBindings: true });
    const zip = await JSZip.loadAsync(await snapshot.arrayBuffer());
    zip.file('src/workers-ai.shared.ts', 'export const WORKERS_AI_CODING_MODEL = "@cf/other/model";\n');

    await expect(inspectDeploymentSnapshot(await asBlob(zip))).rejects.toThrow(
      'differs from the reviewed deployment baseline',
    );
  });
});

async function projectZip(args: {
  projectType?: 'worker';
  includeBindings: boolean;
  compatibilityDate?: string;
  appAgentClassName?: string;
  includeCleanupTrigger?: boolean;
}): Promise<Blob> {
  const zip = new JSZip();
  const packageJson = args.includeBindings
    ? (JSON.parse(readFileSync('template/package.json', 'utf8')) as Record<string, unknown>)
    : { name: 'project' };
  zip.file(
    'package.json',
    JSON.stringify({
      ...packageJson,
      ...(args.projectType ? { ghostbuild: { projectType: args.projectType } } : {}),
    }),
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
            d1_databases: [
              { binding: 'DB', migrations_dir: 'migrations' },
              { binding: 'AGENT_SECURITY_DB', migrations_dir: 'agent-security-migrations' },
            ],
            r2_buckets: [{ binding: 'APP_STORAGE' }],
            durable_objects: { bindings: [{ name: 'AppAgent', class_name: args.appAgentClassName ?? 'AppAgent' }] },
            exports: { AppAgent: { type: 'durable-object', storage: 'sqlite' } },
            ...(args.includeCleanupTrigger === false ? {} : { triggers: { crons: ['0 3 * * *'] } }),
          }
        : {}),
    }),
  );
  if (args.includeBindings) {
    addProtectedSecurityFiles(zip);
  } else {
    zip.file('src/server.ts', "export default { fetch: () => new Response('ok') };\n");
  }
  return asBlob(zip);
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

function addProtectedSecurityFiles(zip: JSZip): void {
  for (const path of Object.keys(APP_AGENT_PROTECTED_FILE_SHA256)) {
    zip.file(path, readFileSync(`template/${path}`, 'utf8'));
  }
  zip.file('pnpm-lock.yaml', readFileSync('template/pnpm-lock.yaml', 'utf8'));
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
      const localHeaderOffset = view.getUint32(offset + 42, true);
      view.setUint32(localHeaderOffset + 22, size, true);
      return;
    }
  }
  throw new Error(`Unable to find ${filename} in ZIP central directory.`);
}

function repeatFirstCentralDirectoryEntry(bytes: Uint8Array<ArrayBuffer>, count: number): Uint8Array<ArrayBuffer> {
  const sourceView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  const centralOffset = sourceView.getUint32(eocd + 16, true);
  const filenameBytes = sourceView.getUint16(centralOffset + 28, true);
  const extraBytes = sourceView.getUint16(centralOffset + 30, true);
  const commentBytes = sourceView.getUint16(centralOffset + 32, true);
  const record = bytes.slice(centralOffset, centralOffset + 46 + filenameBytes + extraBytes + commentBytes);
  const eocdBytes = bytes.slice(eocd);
  const result = new Uint8Array(centralOffset + record.byteLength * count + eocdBytes.byteLength);
  result.set(bytes.subarray(0, centralOffset));
  for (let index = 0; index < count; index += 1) {
    result.set(record, centralOffset + index * record.byteLength);
  }
  const resultEocd = centralOffset + record.byteLength * count;
  result.set(eocdBytes, resultEocd);
  const resultView = new DataView(result.buffer);
  resultView.setUint16(resultEocd + 8, count, true);
  resultView.setUint16(resultEocd + 10, count, true);
  resultView.setUint32(resultEocd + 12, record.byteLength * count, true);
  return result;
}

function findEndOfCentralDirectory(bytes: Uint8Array<ArrayBuffer>): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('ZIP end-of-central-directory record is missing.');
}
