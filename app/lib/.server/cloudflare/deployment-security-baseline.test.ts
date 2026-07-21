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
import { createAppAgentProtectedLockIdentity } from './deployment-security-lock';

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
    expect(
      createHash('sha256')
        .update(fileAggregate)
        .update('\0')
        .update(APP_AGENT_PROTECTED_LOCK_ENTRIES_SHA256)
        .update('\0')
        .digest('hex'),
    ).toBe(APP_AGENT_SECURITY_BOUNDARY_SHA256);
  });

  test('matches the complete protected lock graph while ignoring unrelated application roots', async () => {
    const lock = parseDocument(readFileSync('template/pnpm-lock.yaml', 'utf8')).toJS() as Record<string, any>;
    const lockDigest = await createAppAgentProtectedLockIdentity(lock);
    expect(lockDigest).toBe(APP_AGENT_PROTECTED_LOCK_ENTRIES_SHA256);

    lock.importers['.'].dependencies['legitimate-app-package'] = { specifier: '^1.0.0', version: '1.0.0' };
    lock.packages['legitimate-app-package@1.0.0'] = {
      resolution: { integrity: 'sha512-legitimate-application-dependency' },
    };
    lock.snapshots['legitimate-app-package@1.0.0'] = {};
    await expect(createAppAgentProtectedLockIdentity(lock)).resolves.toBe(APP_AGENT_PROTECTED_LOCK_ENTRIES_SHA256);
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
