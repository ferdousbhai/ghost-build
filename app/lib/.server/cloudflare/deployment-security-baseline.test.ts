import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseDocument } from 'yaml';
import {
  APP_AGENT_PROTECTED_FILE_SHA256,
  APP_AGENT_PROTECTED_LOCK_ENTRIES_SHA256,
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
} from './deployment-security-baseline';

describe('deployment security baseline', () => {
  test('matches every protected template file and its canonical aggregate identity', () => {
    const aggregate = createHash('sha256');
    for (const path of Object.keys(APP_AGENT_PROTECTED_FILE_SHA256).sort()) {
      const digest = createHash('sha256')
        .update(readFileSync(`template/${path}`))
        .digest('hex');
      expect(digest, path).toBe(APP_AGENT_PROTECTED_FILE_SHA256[path as keyof typeof APP_AGENT_PROTECTED_FILE_SHA256]);
      aggregate.update(path);
      aggregate.update('\0');
      aggregate.update(digest);
      aggregate.update('\0');
    }
    const fileAggregate = aggregate.digest('hex');
    const lock = parseDocument(readFileSync('template/pnpm-lock.yaml', 'utf8')).toJS() as Record<string, any>;
    const packageNames = [
      '@cloudflare/ai-chat',
      '@tanstack/react-router',
      '@tanstack/react-start',
      'agents',
      'ai',
      'workers-ai-provider',
      '@cloudflare/vite-plugin',
      '@eslint/js',
      '@tanstack/router-cli',
      '@vitejs/plugin-react',
      'autoprefixer',
      'eslint',
      'eslint-plugin-react-hooks',
      'eslint-plugin-react-refresh',
      'postcss',
      'tailwindcss',
      'typescript',
      'typescript-eslint',
      'vite',
      'wrangler',
    ];
    const importer = lock.importers['.'];
    const protectedEntries = packageNames.sort().map((name) => {
      const entry = importer.dependencies?.[name] ?? importer.devDependencies?.[name];
      const version = entry.version.split('(', 1)[0];
      return {
        name,
        specifier: entry.specifier,
        version,
        integrity: lock.packages[`${name}@${version}`].resolution.integrity,
      };
    });
    const lockDigest = createHash('sha256').update(JSON.stringify(protectedEntries)).digest('hex');
    expect(lockDigest).toBe(APP_AGENT_PROTECTED_LOCK_ENTRIES_SHA256);
    expect(createHash('sha256').update(fileAggregate).update('\0').update(lockDigest).update('\0').digest('hex')).toBe(
      APP_AGENT_SECURITY_BOUNDARY_SHA256,
    );
  });

  test('closes every relative runtime import beneath the protected source boundary', () => {
    const protectedPaths = new Set(Object.keys(APP_AGENT_PROTECTED_FILE_SHA256));
    for (const protectedPath of protectedPaths) {
      if (!protectedPath.startsWith('src/') || !/\.[cm]?[jt]sx?$/.test(protectedPath)) {
        continue;
      }
      const source = readFileSync(`template/${protectedPath}`, 'utf8');
      for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g)) {
        const specifier = match[1]!;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(protectedPath), specifier));
        const resolved = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`].find((candidate) =>
          existsSync(`template/${candidate}`),
        );
        expect(resolved, `${protectedPath} -> ${specifier}`).toBeDefined();
        expect(protectedPaths, `${protectedPath} -> ${resolved}`).toContain(resolved);
      }
    }
  });
});
