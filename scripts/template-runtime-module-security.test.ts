import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { describe, expect, test } from 'vitest';
import {
  findRuntimeModuleImportViolation,
  findRuntimeModuleSecurityViolations,
  productionModuleSecurityPlugin,
} from '../template/scripts/lib/runtime-module-security';

describe('generated app production module security', () => {
  test.each([
    [`export { env as value } from "cloudflare:\\x77orkers";`, 'ambient-workers-module'],
    [`export const value = import("cloudflare:" + "workers");`, 'dynamic-import'],
    [`export const value = require("ordinary-" + "looking-module");`, 'require-call'],
    [`export const value = globalThis["ev" + "al"]("1");`, 'eval-call'],
    [`export const value = new globalThis["Func" + "tion"]("return 1");`, 'function-constructor'],
  ])('rejects a resolved dependency capability: %s', (source, capability) => {
    expect(findRuntimeModuleSecurityViolations(source)).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability })]),
    );
    expect(() => transformResolvedModule(source, '/workspace/node_modules/innocent-helper/index.js')).toThrow(
      `forbidden ${capability} capability`,
    );
  });

  test('allows normal resolved dependencies and only the exact protected binding broker', () => {
    expect(() =>
      transformResolvedModule(
        `export function format(value: string) { return value.trim(); }`,
        '/workspace/node_modules/ordinary-helper/index.ts',
      ),
    ).not.toThrow();
    expect(() =>
      transformResolvedModule(
        `import { env } from "cloudflare:workers"; export const DB = env.DB;`,
        '/workspace/src/app-bindings.ts',
      ),
    ).not.toThrow();
    expect(() =>
      transformResolvedModule(
        `import { env } from "cloudflare:workers"; export const DB = env.DB;`,
        '/workspace/src/routes/unreviewed.ts',
      ),
    ).toThrow('forbidden ambient-workers-module capability');
  });

  test('removes partyserver ambient-environment fallback only from its exact reviewed module', () => {
    const id = createRequire(resolve('template/node_modules/agents/package.json')).resolve('partyserver');
    const source = readFileSync(id, 'utf8');
    const transformed = transformResolvedModule(source, id) as { code: string };

    expect(transformed.code).toContain('import { DurableObject } from "cloudflare:workers";');
    expect(transformed.code).toContain('async function routePartykitRequest(req, env$1, options) {');
    expect(transformed.code).not.toContain('env$1 = env');
    expect(() => transformResolvedModule(`${source}\n`, id)).toThrow('no longer matches its exact security baseline');
  });

  test('allows the narrow application broker but rejects reverse imports into privileged runtime modules', () => {
    const projectDir = '/workspace';
    expect(
      findRuntimeModuleImportViolation(
        '/workspace/src/routes/index.tsx',
        '/workspace/src/app-bindings.ts?import',
        projectDir,
      ),
    ).toBeNull();
    expect(
      findRuntimeModuleImportViolation(
        '/workspace/src/routes/index.tsx',
        '/workspace/src/agents/app-agent.ts?import',
        projectDir,
      ),
    ).toEqual({
      importer: 'project:src/routes/index.tsx',
      imported: 'project:src/agents/app-agent.ts',
    });
    expect(
      findRuntimeModuleImportViolation(
        '/workspace/src/untrusted-helper.ts',
        '/workspace/src/server.ts#worker-entry',
        projectDir,
      ),
    ).toEqual({
      importer: 'project:src/untrusted-helper.ts',
      imported: 'project:src/server.ts',
    });
    expect(
      findRuntimeModuleImportViolation('/workspace/src/server.ts', '/workspace/src/agents/app-agent.ts', projectDir),
    ).toBeNull();
  });

  test('rejects unreviewed imports of mutable Agent runtime package entries', () => {
    const packageRequire = createRequire(resolve('template/package.json'));
    for (const target of [packageRequire.resolve('agents'), packageRequire.resolve('@cloudflare/ai-chat')]) {
      expect(
        findRuntimeModuleImportViolation(resolve('template/src/routes/index.tsx'), target, resolve('template')),
      ).toEqual(expect.objectContaining({ importer: 'project:src/routes/index.tsx' }));
    }
  });

  test('allows only the exact reviewed Agents client helper to import partyserver', () => {
    const packageRequire = createRequire(resolve('template/package.json'));
    const agentsEntry = packageRequire.resolve('agents');
    const reviewedHelper = resolve(agentsEntry, '../client-C7F0MaVz.js');
    const partyserverEntry = createRequire(agentsEntry).resolve('partyserver');

    expect(findRuntimeModuleImportViolation(reviewedHelper, partyserverEntry, resolve('template'))).toBeNull();
    expect(() => transformResolvedModule(readFileSync(reviewedHelper, 'utf8'), reviewedHelper)).not.toThrow();
    expect(() => transformResolvedModule(`${readFileSync(reviewedHelper, 'utf8')}\n`, reviewedHelper)).toThrow(
      'no longer matches its exact security baseline',
    );
  });

  test.each([
    {
      label: 'an indirect aliased import',
      source: [
        'import { AppAgent } from "@/agents/app-agent";',
        'AppAgent.prototype.refreshAnonymousSessionExpiry = async () => true;',
      ].join('\n'),
    },
    {
      label: 'an eager import.meta.glob expansion',
      source: 'export const protectedModules = import.meta.glob("/src/agents/*.ts", { eager: true });',
    },
  ])(
    'rejects $label in a real production build',
    ({ source }) => {
      const output = runAdversarialProductionBuild(source);
      expect(output).toContain('may not import privileged runtime module');
      expect(output).toContain('project:src/untrusted-helper.ts');
      expect(output).toContain('project:src/agents/app-agent.ts');
    },
    70_000,
  );
});

function runAdversarialProductionBuild(untrustedHelperSource: string): string {
  const templateDir = resolve('template');
  const projectDir = mkdtempSync(join(resolve('.'), '.ghostbuild-runtime-security-'));
  try {
    cpSync(templateDir, projectDir, {
      recursive: true,
      filter(source) {
        const sourceRelative = relative(templateDir, source).split(sep);
        return !['node_modules', 'dist', '.wrangler'].includes(sourceRelative[0] ?? '');
      },
    });
    symlinkSync(resolve(templateDir, 'node_modules'), join(projectDir, 'node_modules'), 'dir');
    writeFileSync(join(projectDir, 'src/untrusted-helper.ts'), untrustedHelperSource);
    const routePath = join(projectDir, 'src/routes/index.tsx');
    writeFileSync(routePath, `import "../untrusted-helper";\n${readFileSync(routePath, 'utf8')}`);

    const result = spawnSync('pnpm', ['exec', 'vite', 'build'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...processEnvironment, GHOSTBUILD_PREVIEW: '0' },
      timeout: 60_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    return output;
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function transformResolvedModule(source: string, id: string): unknown {
  const plugin = productionModuleSecurityPlugin('/workspace');
  const transform = plugin.transform;
  if (typeof transform !== 'function') {
    throw new TypeError('Production module security transform hook is unavailable.');
  }
  return transform.call(
    {
      error(message: unknown): never {
        throw new Error(String(message));
      },
    } as never,
    source,
    id,
  );
}
