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

  test('uses only the canonical Cloudflare Vite plugin configuration for dev, build, and preview', () => {
    const viteConfig = readFileSync('template/vite.config.ts', 'utf8');
    const server = readFileSync('template/src/server.ts', 'utf8');
    const pkg = JSON.parse(readFileSync('template/package.json', 'utf8')) as { scripts: Record<string, string> };

    expect(server).toContain('handler.fetch(request)');
    expect(server).toContain('routeAppAgentRequest');
    expect(viteConfig).toContain('cloudflare({');
    expect(viteConfig).toContain('tanstackStart()');
    expect(pkg.scripts.dev).toBe('vite dev --host 0.0.0.0');
    expect(pkg.scripts.preview).toBe('vite preview --host 0.0.0.0');
    expect(existsSync('template/vite.preview.config.mjs')).toBe(false);
    expect(existsSync('template/src/preview')).toBe(false);
    expect(existsSync('template/index.html')).toBe(false);
  });
});
