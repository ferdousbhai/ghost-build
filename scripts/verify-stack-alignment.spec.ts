import { describe, expect, it } from 'vitest';
import {
  dependencyNames,
  findForbiddenFiles,
  findForbiddenLegacyPaths,
  findForbiddenDependencies,
  findForbiddenImports,
  findForbiddenRuntimeEnvAccess,
  findCloudflareAiPeerCompatibilityErrors,
  findMissingDependencies,
  findMissingCommandSteps,
  findPackageVersionAlignmentErrors,
  findRuntimePinErrors,
  findRootMigrationErrors,
  findTemplateSnapshotErrors,
  findTemplateSnapshotManifestErrors,
  packageDependencyVersion,
} from './verify-stack-alignment.mjs';

describe('stack alignment verification helpers', () => {
  it('collects dependency names across package sections', () => {
    expect(
      dependencyNames({
        dependencies: { '@tanstack/react-start': '^1.0.0' },
        devDependencies: { wrangler: '^4.0.0' },
      }),
    ).toEqual(new Set(['@tanstack/react-start', 'wrangler']));
  });

  it('rejects Convex, Remix, and non-Workers-AI model providers', () => {
    const errors = findForbiddenDependencies(
      {
        dependencies: {
          convex: '^1.0.0',
          '@remix-run/react': '^2.0.0',
          '@ai-sdk/openai': '^4.0.0',
          '@ai-sdk/amazon-bedrock': '^3.0.0',
        },
        devDependencies: {
          '@types/diff': '^8.0.0',
        },
      },
      'package.json',
    );

    expect(errors).toHaveLength(5);
  });

  it('reports missing required stack dependencies', () => {
    expect(
      findMissingDependencies({ dependencies: { agents: '^1.0.0' } }, 'package.json', ['agents', 'wrangler']),
    ).toEqual(['package.json must include wrangler for the TanStack Start + Cloudflare stack.']);
  });

  it('requires aligned Cloudflare/TanStack package versions and compatible AI peers', () => {
    const pkg = {
      dependencies: {
        '@cloudflare/ai-chat': '^0.9.1',
        '@ai-sdk/provider': '^3.0.12',
        '@tanstack/react-start': '^1.168.26',
        agents: '^0.17.1',
        ai: '^6.0.216',
        'workers-ai-provider': '^3.3.0',
        zod: '^4.4.3',
      },
      devDependencies: {
        '@ai-sdk/react': '^3.0.218',
        wrangler: '^4.105.0',
      },
    };

    expect(packageDependencyVersion(pkg, '@ai-sdk/react')).toBe('^3.0.218');
    expect(findCloudflareAiPeerCompatibilityErrors(pkg, 'package.json')).toEqual([]);
    expect(findPackageVersionAlignmentErrors(pkg, pkg, 'template/package.json', ['ai', 'zod'])).toEqual([]);
    expect(
      findPackageVersionAlignmentErrors(pkg, { dependencies: { ai: '^6.0.217' } }, 'template/package.json', ['ai']),
    ).toEqual(['template/package.json must align ai with package.json ^6.0.216; found ^6.0.217.']);
  });

  it('keeps AI SDK packages on the current Cloudflare-compatible peer line', () => {
    expect(
      findCloudflareAiPeerCompatibilityErrors(
        {
          dependencies: {
            '@ai-sdk/provider': '^4.0.0',
            '@ai-sdk/react': '^4.0.7',
            '@cloudflare/ai-chat': '^0.9.1',
            agents: '^0.17.1',
            ai: '^7.0.6',
            'workers-ai-provider': '^3.3.0',
          },
        },
        'package.json',
      ),
    ).toEqual([
      'package.json must keep ai on ^6.x while agents, @cloudflare/ai-chat, workers-ai-provider require ai ^6.0.0; found ^7.0.6.',
      'package.json must keep @ai-sdk/react on ^3.x while agents, @cloudflare/ai-chat, workers-ai-provider require @ai-sdk/react ^3.0.204; found ^4.0.7.',
      'package.json must keep @ai-sdk/provider on ^3.x while agents, @cloudflare/ai-chat, workers-ai-provider require @ai-sdk/provider ^3.0.0; found ^4.0.0.',
    ]);
  });

  it('reports forbidden generated lockfiles', () => {
    expect(findForbiddenFiles(['scripts/fixtures/forbidden-stack-imports.txt'])).toEqual([
      'scripts/fixtures/forbidden-stack-imports.txt must not exist; Ghostbuild uses pnpm lockfiles only.',
    ]);
  });

  it('reports forbidden legacy stack paths', () => {
    expect(findForbiddenLegacyPaths(['scripts/fixtures/forbidden-stack-imports.txt'])).toEqual([
      'scripts/fixtures/forbidden-stack-imports.txt must not exist; Ghostbuild uses TanStack Start and Cloudflare-only providers.',
    ]);
  });

  it('requires the production Node and pnpm toolchain pins', () => {
    expect(
      findRuntimePinErrors(
        {
          engines: { node: '>=26.0.0' },
          packageManager: 'pnpm@9.5.0',
          devDependencies: { '@types/node': '^26.1.0' },
        },
        'package.json',
      ),
    ).toEqual([]);

    expect(findRuntimePinErrors({ devDependencies: {} }, 'package.json')).toEqual([
      'package.json must set engines.node to >=26.0.0.',
      'package.json must pin packageManager to pnpm@9.5.0.',
      'package.json must use @types/node ^26.x for the Node 26 toolchain.',
    ]);
  });

  it('requires exactly one generated template snapshot referenced by setup code', () => {
    expect(
      findTemplateSnapshotErrors(
        ['template-snapshot-1234abcd.bin'],
        "const TEMPLATE_URL = '/template-snapshot-1234abcd.bin';",
        new Map([['template-snapshot-1234abcd.bin', '1234abcd']]),
      ),
    ).toEqual([]);

    expect(findTemplateSnapshotErrors([], '')).toEqual([
      'public must contain exactly one template-snapshot-*.bin file; found none.',
    ]);

    expect(findTemplateSnapshotErrors(['template-snapshot-1234abcd.bin'], "const TEMPLATE_URL = '/old.bin';")).toEqual([
      'app/lib/stores/startup/useContainerSetup.ts must reference /template-snapshot-1234abcd.bin.',
    ]);

    expect(
      findTemplateSnapshotErrors(
        ['template-snapshot-1234abcd.bin'],
        "const TEMPLATE_URL = '/template-snapshot-1234abcd.bin';",
        new Map([['template-snapshot-1234abcd.bin', 'deadbeef']]),
      ),
    ).toEqual(['template-snapshot-1234abcd.bin hash must match its compressed snapshot content; expected deadbeef.']);
  });

  it('requires chat persistence uniqueness migrations', () => {
    const requiredTables = [
      'chats',
      'chat_message_states',
      'shares',
      'social_shares',
      'object_gc_candidates',
      'user',
      'session',
      'account',
      'verification',
    ]
      .map((table) => `CREATE TABLE IF NOT EXISTS ${table} (id TEXT);`)
      .join('\n');

    expect(findRootMigrationErrors(requiredTables)).toContain(
      'root migrations must enforce one chat message state per chat, subchat, and message rank.',
    );
    expect(findRootMigrationErrors(requiredTables)).toContain(
      'root migrations must enforce one active chat per creator and initial id.',
    );
    expect(findRootMigrationErrors(requiredTables)).toContain(
      'root migrations must enforce one social share per chat.',
    );
    expect(findRootMigrationErrors(requiredTables)).toContain(
      'root migrations must defer cleanup of displaced R2 object keys.',
    );
    expect(
      findRootMigrationErrors(
        `${requiredTables}
         CREATE UNIQUE INDEX states_rank ON chat_message_states(chat_id, subchat_index, last_message_rank);
         CREATE UNIQUE INDEX active_chat ON chats(creator_id, initial_id) WHERE is_deleted = 0;
         CREATE UNIQUE INDEX social_chat ON social_shares(chat_id);
         INSERT OR IGNORE INTO object_gc_candidates (storage_key, not_before) VALUES ('key', 1);`,
      ),
    ).toEqual([]);
  });

  it('requires the template snapshot manifest to match the artifact and current source', () => {
    expect(
      findTemplateSnapshotManifestErrors(
        { snapshot: 'template-snapshot-1234abcd.bin', sourceSha256: 'source-hash' },
        'template-snapshot-1234abcd.bin',
        'source-hash',
      ),
    ).toEqual([]);
    expect(
      findTemplateSnapshotManifestErrors(
        { snapshot: 'template-snapshot-old.bin', sourceSha256: 'old-source' },
        'template-snapshot-1234abcd.bin',
        'source-hash',
      ),
    ).toEqual([
      'public/template-snapshot-manifest.json must reference template-snapshot-1234abcd.bin.',
      'public/template-snapshot-manifest.json is stale; run pnpm run rebuild-template.',
    ]);
  });

  it('rejects forbidden framework and provider imports', () => {
    const errors = findForbiddenImports([new URL('./fixtures/forbidden-stack-imports.txt', import.meta.url).pathname]);

    expect(errors).toHaveLength(4);
  });

  it('rejects runtime env access outside explicit SSR-only allowlists', () => {
    const fixture = new URL('./fixtures/forbidden-runtime-env-access.ts', import.meta.url).pathname;

    expect(findForbiddenRuntimeEnvAccess([fixture])).toEqual([
      `${fixture}:1 must read runtime config from Cloudflare Worker bindings, not process.env or import.meta.env.`,
      `${fixture}:2 must read runtime config from Cloudflare Worker bindings, not process.env or import.meta.env.`,
    ]);
  });

  it('allows the WebContainer SSR gate without allowing other import.meta.env usage', () => {
    const fixture = new URL('./fixtures/forbidden-runtime-env-access.ts', import.meta.url).pathname;

    expect(
      findForbiddenRuntimeEnvAccess(
        [fixture],
        [
          {
            pathSuffix: 'fixtures/forbidden-runtime-env-access.ts',
            snippet: 'import.meta.env.VITE_OPENAI_API_KEY',
          },
        ],
      ),
    ).toEqual([
      `${fixture}:1 must read runtime config from Cloudflare Worker bindings, not process.env or import.meta.env.`,
    ]);
  });

  it('validates command contracts without coupling to one exact command string', () => {
    expect(
      findMissingCommandSteps('pnpm run verify:stack && pnpm run typecheck && pnpm run build', 'scripts.validate', [
        'verify:stack',
        'typecheck',
        'build',
      ]),
    ).toEqual([]);
    expect(findMissingCommandSteps('pnpm run build', 'scripts.validate', ['typecheck', 'build'])).toEqual([
      'scripts.validate must run "typecheck" in order.',
    ]);
  });
});
