import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { copyCanonicalTemplateSource } from './verify-template.mjs';

describe('standalone template verification source', () => {
  test('starts from the canonical snapshot source and generates bindings before stack verification', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ghostbuild-template-source-'));
    try {
      await copyCanonicalTemplateSource(tempDir);

      expect(existsSync(join(tempDir, 'package.json'))).toBe(true);
      expect(existsSync(join(tempDir, 'package-lock.json'))).toBe(false);
      expect(existsSync(join(tempDir, 'preview-runtime'))).toBe(false);
      expect(existsSync(join(tempDir, 'worker-configuration.d.ts'))).toBe(false);

      const pkg = JSON.parse(readFileSync(join(tempDir, 'package.json'), 'utf8')) as {
        scripts: { deploy: string; typecheck: string };
      };
      expect(pkg.scripts.typecheck).toContain('cf-typegen');
      expect(pkg.scripts.deploy.indexOf('pnpm run typecheck')).toBeLessThan(
        pkg.scripts.deploy.indexOf('pnpm run verify:stack'),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('uses the canonical Cloudflare Vite plugin with a minimal isolated Preview entrypoint', () => {
    const viteConfig = readFileSync('template/vite.config.ts', 'utf8');
    const server = readFileSync('template/src/server.ts', 'utf8');
    const plainServer = readFileSync('template/src/plain-server.ts', 'utf8');
    const previewServer = readFileSync('template/src/preview-server.ts', 'utf8');
    const previewConfig = readFileSync('template/wrangler.preview.jsonc', 'utf8');
    const pkg = JSON.parse(readFileSync('template/package.json', 'utf8')) as { scripts: Record<string, string> };

    expect(server).toContain('handler.fetch(request)');
    expect(server).toContain('routeAppAgentRequest');
    expect(plainServer).toContain('handler.fetch(request)');
    expect(server).not.toContain('GHOSTBUILD_ISOLATED_PREVIEW');
    expect(server).not.toContain('isAgentRoute');
    expect(viteConfig).toContain('cloudflare(cloudflareOptions)');
    expect(viteConfig).toContain('tanstackStart()');
    expect(previewServer).toContain('handler.fetch(request)');
    expect(previewServer).toContain('isolatedPreview: true');
    expect(previewConfig).toContain('"main": "src/preview-server.ts"');
    expect(previewConfig).toContain('"d1_databases"');
    expect(previewConfig).toContain('"r2_buckets"');
    expect(previewConfig).not.toContain('"durable_objects"');
    expect(previewConfig).not.toContain('"ai"');
    expect(previewConfig).not.toContain('"vars"');
    expect(previewConfig).not.toContain('"exports"');
    expect(pkg.scripts.dev).toBe('vite dev --host 0.0.0.0');
    expect(pkg.scripts.preview).toBe('vite preview --host 0.0.0.0');
    expect(existsSync('template/vite.preview.config.mjs')).toBe(false);
    expect(existsSync('template/src/preview')).toBe(false);
    expect(existsSync('template/index.html')).toBe(false);
  });
});
