import { describe, expect, it } from 'vitest';
import { assertValidGeneratedPackageJson, findForbiddenGeneratedPackageDependencies } from './generatedPackageManifest';

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
