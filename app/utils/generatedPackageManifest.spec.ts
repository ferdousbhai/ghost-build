import { describe, expect, it } from 'vitest';
import {
  assertValidGeneratedPackageJson,
  findForbiddenGeneratedPackageDependencies,
  findForbiddenGeneratedPackageManagerPolicyFields,
  findInvalidGeneratedPackageSources,
} from './generatedPackageManifest';

describe('generated package manifest guard', () => {
  it('allows TanStack Start and Cloudflare dependencies', () => {
    expect(() =>
      assertValidGeneratedPackageJson(
        'package.json',
        JSON.stringify({
          dependencies: {
            '@tanstack/react-start': '^1.168.26',
            '@tanstack/react-query': '^5.101.2',
            '@ai-sdk/provider': '^3.0.12',
            '@ai-sdk/react': '^3.0.218',
            agents: '^0.17.1',
            'workers-ai-provider': '^3.3.0',
          },
          devDependencies: {
            wrangler: '^4.105.0',
            '@cloudflare/vite-plugin': '^1.42.3',
          },
          peerDependencies: {
            react: '^18.0.0 || ^19.0.0',
          },
        }),
      ),
    ).not.toThrow();
  });

  it('finds forbidden dependency sections', () => {
    expect(
      findForbiddenGeneratedPackageDependencies({
        dependencies: {
          convex: '^1.0.0',
          '@remix-run/react': '^2.0.0',
        },
        devDependencies: {
          '@ai-sdk/openai': '^4.0.0',
          '@ai-sdk/amazon-bedrock': '^3.0.0',
          '@google/genai': '^1.0.0',
        },
      }),
    ).toEqual([
      { section: 'dependencies', packageName: 'convex' },
      { section: 'dependencies', packageName: '@remix-run/react' },
      { section: 'devDependencies', packageName: '@ai-sdk/openai' },
      { section: 'devDependencies', packageName: '@ai-sdk/amazon-bedrock' },
      { section: 'devDependencies', packageName: '@google/genai' },
    ]);
  });

  it('blocks npm alias versions that point at non-Workers-AI providers', () => {
    expect(() =>
      assertValidGeneratedPackageJson(
        'packages/app/package.json',
        JSON.stringify({
          dependencies: {
            'model-sdk': 'npm:@anthropic-ai/sdk@latest',
          },
        }),
      ),
    ).toThrow(/dependencies\.@anthropic-ai\/sdk/);
  });

  it('blocks dependency sources that bypass the configured npm registry', () => {
    const manifest = {
      dependencies: {
        remote: 'https://example.com/package.tgz',
        git: 'github:example/package',
        local: 'file:../local-package',
      },
      devDependencies: { workspace: 'workspace:*' },
    };
    expect(findInvalidGeneratedPackageSources(manifest)).toEqual([
      { section: 'dependencies', packageName: 'remote', versionSpec: 'https://example.com/package.tgz' },
      { section: 'dependencies', packageName: 'git', versionSpec: 'github:example/package' },
      { section: 'dependencies', packageName: 'local', versionSpec: 'file:../local-package' },
      { section: 'devDependencies', packageName: 'workspace', versionSpec: 'workspace:*' },
    ]);
    expect(() => assertValidGeneratedPackageJson('package.json', JSON.stringify(manifest))).toThrow(
      /must use npm registry versions/,
    );
  });

  it('allows registry-backed npm aliases', () => {
    expect(() =>
      assertValidGeneratedPackageJson(
        'package.json',
        JSON.stringify({ dependencies: { 'date-tools': 'npm:date-fns@^4.0.0' } }),
      ),
    ).not.toThrow();
  });

  it('blocks package-manager fields that can replace registry resolution or build policy', () => {
    const manifest = {
      dependenciesMeta: { esbuild: { built: true } },
      overrides: { react: 'https://example.invalid/react.tgz' },
      pnpm: { dangerouslyAllowAllBuilds: true },
      resolutions: { react: 'file:../react' },
    };
    expect(findForbiddenGeneratedPackageManagerPolicyFields(manifest)).toEqual([
      'dependenciesMeta',
      'overrides',
      'pnpm',
      'resolutions',
    ]);
    expect(() => assertValidGeneratedPackageJson('package.json', JSON.stringify(manifest))).toThrow(
      /must not override dependency resolution or build policy/,
    );
  });

  it('ignores non-package files and partial package json writes', () => {
    expect(() =>
      assertValidGeneratedPackageJson('src/package-data.json', '{"dependencies":{"openai":"latest"}}'),
    ).not.toThrow();
    expect(() =>
      assertValidGeneratedPackageJson('packages\\app\\package.json', '{"dependencies":{"openai":"latest"}}'),
    ).toThrow(/dependencies\.openai/);
    expect(() => assertValidGeneratedPackageJson('package.json', '{"dependencies":')).not.toThrow();
  });
});
