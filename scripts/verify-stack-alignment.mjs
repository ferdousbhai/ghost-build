import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_REQUIRED_PACKAGES,
  collectSourceEntries,
  dependencyNames,
  findCloudflareAiPeerCompatibilityErrors,
  findForbiddenDependencies,
  findBuildApprovalErrors,
  findForbiddenImports,
  findForbiddenPaths,
  findForbiddenRuntimeEnvAccess as findForbiddenRuntimeEnvAccessShared,
  findMissingCommandSteps,
  findMissingDependencies,
  findMissingPaths,
  findPackageVersionAlignmentErrors,
  findRuntimePinErrors,
  packageDependencyVersion,
} from '../template/scripts/lib/project-policy.mjs';
import { runVerifierIfMain } from './run-verifier.mjs';
import { templateSourceDigest } from './template-source.mjs';

export {
  dependencyNames,
  findCloudflareAiPeerCompatibilityErrors,
  findForbiddenDependencies,
  findForbiddenImports,
  findMissingCommandSteps,
  findMissingDependencies,
  findPackageVersionAlignmentErrors,
  findRuntimePinErrors,
  packageDependencyVersion,
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templateSnapshotPattern = /^template-snapshot-([a-f0-9]{8})\.bin$/;
const runtimeEnvAccessAllowlist = [
  { pathSuffix: 'app/components/ErrorComponent.tsx', snippet: 'import.meta.env.DEV' },
  { pathSuffix: 'app/lib/webcontainer/index.ts', snippet: 'import.meta.env.SSR' },
  { pathSuffix: 'template/vite.config.ts', snippet: 'process.env.GHOSTBUILD_PREVIEW' },
];
const agentRequiredPackages = ['ai', 'zod'];
const forbiddenLockfiles = ['package-lock.json', 'template/package-lock.json'];
const forbiddenLegacyPaths = [
  '.cursor/rules/convex_rules.mdc',
  'app/components/convex',
  'app/components/chat/ChefAuthWrapper.tsx',
  'app/components/chat/ModelSelector.tsx',
  'app/lib/.server/llm/convex-agent.ts',
  'app/lib/convexOptins.ts',
  'app/lib/convexProfile.ts',
  'app/lib/convexUsage.ts',
  'app/routes/api.convex.callback.ts',
  'chef-agent',
  'convex',
  'template/convex',
];
const requiredPaths = [
  'app/server.ts',
  'app/agents/builder-agent.ts',
  'app/lib/.server/chat.ts',
  'app/lib/workers-ai-model.ts',
  'ghostbuild-agent/package.json',
  'ghostbuild-agent/tsconfig.json',
  'template/package.json',
  'template/pnpm-lock.yaml',
  'template/src/server.ts',
  'template/src/agents/app-agent.ts',
  'template/vite.config.ts',
  'template/wrangler.jsonc',
  'public/template-snapshot-manifest.json',
];
const requiredMigrationTables = [
  'user',
  'session',
  'account',
  'verification',
  'chats',
  'chat_message_states',
  'shares',
  'social_shares',
  'object_gc_candidates',
];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(rootDir, path), 'utf8'));
}

export function findForbiddenFiles(paths) {
  return findForbiddenPaths(rootDir, paths, 'Ghostbuild uses pnpm lockfiles only');
}

export function findForbiddenLegacyPaths(paths) {
  return findForbiddenPaths(rootDir, paths, 'Ghostbuild uses TanStack Start and Cloudflare-only providers');
}

export function findForbiddenRuntimeEnvAccess(files, allowlist = runtimeEnvAccessAllowlist) {
  return findForbiddenRuntimeEnvAccessShared(files, allowlist);
}

export function findTemplateSnapshotErrors(snapshotFiles, setupContent, hashByFile = new Map()) {
  const errors = [];
  const snapshotNames = snapshotFiles.map((file) => file.split('/').pop() ?? file).sort();
  if (snapshotNames.length !== 1) {
    return [`public must contain exactly one template-snapshot-*.bin file; found ${snapshotNames.length || 'none'}.`];
  }

  const [snapshotName] = snapshotNames;
  const match = templateSnapshotPattern.exec(snapshotName);
  if (!match) {
    return [`${snapshotName} must match template-snapshot-<8 hex chars>.bin.`];
  }
  if (!setupContent.includes(`const TEMPLATE_URL = '/${snapshotName}';`)) {
    errors.push(`app/lib/stores/startup/useContainerSetup.ts must reference /${snapshotName}.`);
  }
  const actualHash = hashByFile.get(snapshotName);
  if (actualHash && actualHash !== match[1]) {
    errors.push(`${snapshotName} hash must match its compressed snapshot content; expected ${actualHash}.`);
  }
  return errors;
}

export function findTemplateSnapshotManifestErrors(manifest, snapshotName, sourceSha256) {
  const errors = [];
  if (manifest?.snapshot !== snapshotName) {
    errors.push(`public/template-snapshot-manifest.json must reference ${snapshotName}.`);
  }
  if (manifest?.sourceSha256 !== sourceSha256) {
    errors.push('public/template-snapshot-manifest.json is stale; run pnpm run rebuild-template.');
  }
  return errors;
}

function verifyPackage(errors, pkg, label, requiredPackages, checkAiPeers = false) {
  errors.push(
    ...findForbiddenDependencies(pkg, label),
    ...findMissingDependencies(pkg, label, requiredPackages),
    ...findRuntimePinErrors(pkg, label),
  );
  if (checkAiPeers) {
    errors.push(...findCloudflareAiPeerCompatibilityErrors(pkg, label));
  }
}

function verifyWorkspace(errors) {
  const workspace = readFileSync(resolve(rootDir, 'pnpm-workspace.yaml'), 'utf8');
  for (const packagePath of ['ghostbuild-agent', 'template']) {
    if (!new RegExp(`- ['"]?${packagePath}['"]?`).test(workspace)) {
      errors.push(`pnpm-workspace.yaml must include ${packagePath}.`);
    }
  }
  errors.push(...findBuildApprovalErrors(workspace, 'pnpm-workspace.yaml'));
  if (/set this to true or false/i.test(workspace)) {
    errors.push('pnpm-workspace.yaml must not contain unresolved build-approval placeholders.');
  }
}

function verifyToolchainConfig(errors) {
  const nodeVersion = readFileSync(resolve(rootDir, '.nvmrc'), 'utf8').trim();
  const setupAction = readFileSync(resolve(rootDir, '.github/actions/setup-and-build/action.yaml'), 'utf8');
  if (nodeVersion !== '26.3.0') {
    errors.push('.nvmrc must pin Node.js 26.3.0.');
  }
  if (!setupAction.includes("default: '26.3.0'")) {
    errors.push('the setup action must default to Node.js 26.3.0.');
  }
  if (!setupAction.includes("default: '9.5.0'")) {
    errors.push('the setup action must default to pnpm 9.5.0.');
  }
}

function verifyRootMigrations(errors) {
  const migrationsDir = resolve(rootDir, 'migrations');
  const sql = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(resolve(migrationsDir, file), 'utf8'))
    .join('\n');
  errors.push(...findRootMigrationErrors(sql));
}

export function findRootMigrationErrors(sql) {
  const errors = [];
  for (const table of requiredMigrationTables) {
    if (!new RegExp(`CREATE TABLE IF NOT EXISTS ["']?${table}["']?`, 'i').test(sql)) {
      errors.push(`root migrations must create the ${table} table.`);
    }
  }
  if (
    !/CREATE\s+UNIQUE\s+INDEX[\s\S]*?ON\s+chat_message_states\s*\(\s*chat_id\s*,\s*subchat_index\s*,\s*last_message_rank\s*\)/i.test(
      sql,
    )
  ) {
    errors.push('root migrations must enforce one chat message state per chat, subchat, and message rank.');
  }
  if (
    !/CREATE\s+UNIQUE\s+INDEX[\s\S]*?ON\s+chats\s*\(\s*creator_id\s*,\s*initial_id\s*\)[\s\S]*?WHERE\s+is_deleted\s*=\s*0/i.test(
      sql,
    )
  ) {
    errors.push('root migrations must enforce one active chat per creator and initial id.');
  }
  if (!/CREATE\s+UNIQUE\s+INDEX[\s\S]*?ON\s+social_shares\s*\(\s*chat_id\s*\)/i.test(sql)) {
    errors.push('root migrations must enforce one social share per chat.');
  }
  if (!/INSERT\s+OR\s+IGNORE\s+INTO\s+object_gc_candidates/i.test(sql) || !/not_before/i.test(sql)) {
    errors.push('root migrations must defer cleanup of displaced R2 object keys.');
  }
  return errors;
}

function collectSnapshots() {
  return readdirSync(resolve(rootDir, 'public')).filter((file) => /^template-snapshot-.*\.bin$/.test(file));
}

function snapshotHashes(files) {
  return new Map(
    files.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(resolve(rootDir, 'public', file)))
        .digest('hex')
        .slice(0, 8),
    ]),
  );
}

export function verifyStackAlignment() {
  const errors = [];
  const rootPackage = readJson('package.json');
  const agentPackage = readJson('ghostbuild-agent/package.json');
  const templatePackage = readJson('template/package.json');

  verifyPackage(errors, rootPackage, 'package.json', APP_REQUIRED_PACKAGES, true);
  verifyPackage(errors, agentPackage, 'ghostbuild-agent/package.json', agentRequiredPackages);
  verifyPackage(errors, templatePackage, 'template/package.json', APP_REQUIRED_PACKAGES, true);
  errors.push(
    ...findPackageVersionAlignmentErrors(
      rootPackage,
      agentPackage,
      'ghostbuild-agent/package.json',
      agentRequiredPackages,
    ),
    ...findPackageVersionAlignmentErrors(rootPackage, templatePackage, 'template/package.json', APP_REQUIRED_PACKAGES),
    ...findForbiddenFiles(forbiddenLockfiles),
    ...findForbiddenLegacyPaths(forbiddenLegacyPaths),
    ...findMissingPaths(rootDir, requiredPaths),
  );

  if (rootPackage.license !== 'Apache-2.0') {
    errors.push('package.json must declare Apache-2.0 licensing.');
  }
  errors.push(
    ...findMissingCommandSteps(rootPackage.scripts?.validate, 'package.json scripts.validate', [
      'validate:root',
      'validate:agent',
      'validate:template',
    ]),
    ...findMissingCommandSteps(rootPackage.scripts?.['validate:agent'], 'package.json scripts.validate:agent', [
      'ghostbuild-agent',
      'typecheck',
    ]),
    ...findMissingCommandSteps(rootPackage.scripts?.['validate:root'], 'package.json scripts.validate:root', [
      'verify:stack',
      'verify:production-config',
      'typecheck',
      'lint',
      'test',
      'knip',
      'build',
      'bundle:check',
    ]),
    ...findMissingCommandSteps(rootPackage.scripts?.['validate:template'], 'package.json scripts.validate:template', [
      'scripts/verify-template.mjs',
    ]),
  );

  verifyWorkspace(errors);
  verifyToolchainConfig(errors);
  verifyRootMigrations(errors);

  const snapshots = collectSnapshots();
  errors.push(
    ...findTemplateSnapshotErrors(
      snapshots,
      readFileSync(resolve(rootDir, 'app/lib/stores/startup/useContainerSetup.ts'), 'utf8'),
      snapshotHashes(snapshots),
    ),
  );
  if (snapshots.length === 1) {
    errors.push(
      ...findTemplateSnapshotManifestErrors(
        readJson('public/template-snapshot-manifest.json'),
        snapshots[0],
        templateSourceDigest(rootDir),
      ),
    );
  }

  const sourceFiles = collectSourceEntries(rootDir, [
    'app',
    'ghostbuild-agent',
    'template/src',
    'vite.config.ts',
    'template/vite.config.ts',
  ]);
  errors.push(...findForbiddenImports(sourceFiles), ...findForbiddenRuntimeEnvAccess(sourceFiles));

  return errors;
}

runVerifierIfMain(import.meta.url, verifyStackAlignment);
