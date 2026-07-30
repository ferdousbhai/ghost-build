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
import { verifyD1MigrationSafety } from './verify-d1-migrations.mjs';
import { findWorkspacePolicyErrors } from '../sandbox-tools/verify-pnpm-workspace-policy.mjs';

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
const SANDBOX_IMAGE_DIGEST = 'sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042';
const SANDBOX_NODE_ENGINE = '>=22.0.0';
const templateSnapshotPattern = /^template-snapshot-([a-f0-9]{8})\.bin$/;
const runtimeEnvAccessAllowlist = [
  { pathSuffix: 'app/components/ErrorComponent.tsx', snippet: 'import.meta.env.DEV' },
  { pathSuffix: 'app/lib/webcontainer/index.ts', snippet: 'import.meta.env.SSR' },
  { pathSuffix: 'template/scripts/vite-dev.mjs', snippet: 'process.env.GHOSTBUILD_PREVIEW' },
];
const agentRequiredPackages = ['ai', 'zod'];
const SANDBOX_YAML_VERSION = '2.9.0';
const forbiddenLockfiles = ['package-lock.json'];
const forbiddenDependencyUpdateConfigs = ['.github/dependabot.yml', '.github/dependabot.yaml'];
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
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES',
  'app/server.ts',
  'Dockerfile.sandbox',
  'sandbox-tools/package.json',
  'sandbox-tools/pnpm-lock.yaml',
  'sandbox-tools/pnpm-workspace.yaml',
  'sandbox-tools/verify-pnpm-workspace-policy.mjs',
  'app/agents/builder-agent.ts',
  'app/lib/.server/chat.ts',
  'app/lib/.server/cloudflare/deployment-build-artifact.ts',
  'app/lib/.server/cloudflare/deployment-runtime-policy.ts',
  'app/lib/.server/cloudflare/deployment-workflow.ts',
  'app/lib/workers-ai-model.ts',
  'ghostbuild-agent/package.json',
  'ghostbuild-agent/tsconfig.json',
  'template/package.json',
  'template/pnpm-lock.yaml',
  'template/src/server.ts',
  'template/src/agents/app-agent.ts',
  'template/src/agents/anonymous-retention.ts',
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
  'agent_gc_candidates',
  'cloudflare_auth_sessions',
  'cloudflare_oauth_states',
  'cloudflare_credentials',
  'cloudflare_connections',
  'deployments',
  'deployment_resources',
  'chat_backup_admissions',
  'chat_backup_objects',
  'chat_backup_object_attributions',
  'chat_backup_reconciliation_state',
  'thumbnail_upload_admissions',
  'thumbnail_objects',
  'thumbnail_reconciliation_state',
  'deployment_security_inventory',
];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(rootDir, path), 'utf8'));
}

export function findForbiddenFiles(paths) {
  return findForbiddenPaths(rootDir, paths, 'Ghostbuild uses pnpm lockfiles only');
}

export function findForbiddenDependencyUpdateConfigs(paths) {
  return findForbiddenPaths(
    rootDir,
    paths,
    'Ghostbuild uses private vulnerability alerts without automated dependency update pull requests',
  );
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

export function findBuilderTemplateModuleErrors(content, sourceSha256) {
  return content.includes(`export const BUILDER_TEMPLATE_SOURCE_SHA256 = '${sourceSha256}';`)
    ? []
    : ['app/agents/builder-template.generated.ts is stale; run pnpm run rebuild-template.'];
}

export function findDeploymentWorkflowErrors(content) {
  const errors = [];
  const requiredStepNames = [
    'claim, build, and persist approved deployment artifact',
    'verify artifact, provision, publish, and clean up deployment',
  ];
  for (const stepName of requiredStepNames) {
    if (!content.includes(`'${stepName}'`)) {
      errors.push(`deployment Workflow must include the durable step "${stepName}".`);
    }
  }
  const thirtyMinuteTimeouts = content.match(/timeout:\s*'30 minutes'/g)?.length ?? 0;
  if (thirtyMinuteTimeouts !== requiredStepNames.length) {
    errors.push('deployment Workflow must give both durable steps an explicit 30-minute timeout.');
  }
  const disabledRetries = content.match(/retries:\s*\{\s*limit:\s*0\b/g)?.length ?? 0;
  if (disabledRetries !== requiredStepNames.length) {
    errors.push('deployment Workflow must disable automatic retries for both provider-sensitive steps.');
  }
  if (!/\bbuildApprovedDeploymentArtifact\b/.test(content) || !/\bpublishApprovedDeploymentArtifact\b/.test(content)) {
    errors.push('deployment Workflow must preserve the R2 receipt boundary between build and publish.');
  }
  return errors;
}

export function findDeploymentRuntimePolicyErrors(templateConfigSource, runtimePolicySource) {
  const runtimeMatch = /export const DEPLOYMENT_COMPATIBILITY_DATE = '([^']+)'/.exec(runtimePolicySource);
  if (!runtimeMatch) {
    return ['deployment runtime policy must declare DEPLOYMENT_COMPATIBILITY_DATE.'];
  }
  const templateMatch = /"compatibility_date"\s*:\s*"([^"]+)"/.exec(templateConfigSource);
  if (!templateMatch) {
    return ['template/wrangler.jsonc must declare compatibility_date.'];
  }
  return runtimeMatch[1] === templateMatch[1]
    ? []
    : [
        `deployment compatibility date ${JSON.stringify(runtimeMatch[1])} must match template/wrangler.jsonc ${JSON.stringify(templateMatch[1])}.`,
      ];
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

export function findInternalPackageMetadataErrors(pkg, label) {
  return pkg?.private === true ? [] : [`${label} must set private to true so it cannot be published accidentally.`];
}

export function findSandboxVersionErrors(pkg, dockerfile, toolsPackage, toolsLockfile, label = 'Dockerfile.sandbox') {
  const errors = [];
  const sandboxVersion = packageDependencyVersion(pkg, '@cloudflare/sandbox');
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(sandboxVersion ?? '')) {
    return ['package.json must pin @cloudflare/sandbox to an exact version.'];
  }

  const expectedImage = `FROM docker.io/cloudflare/sandbox:${sandboxVersion}@${SANDBOX_IMAGE_DIGEST}`;
  if (!dockerfile.split('\n').includes(expectedImage)) {
    errors.push(`${label} must use ${expectedImage} so the image matches the Sandbox SDK.`);
  }
  const packageManager = pkg?.packageManager;
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager ?? '')?.[1];
  if (!pnpmVersion || !dockerfile.includes(`pnpm@${pnpmVersion}`)) {
    errors.push(`${label} must install ${packageManager ?? 'the package.json pnpm version'} to match packageManager.`);
  }
  if (
    pnpmVersion &&
    !dockerfile.includes(`npm install --global pnpm@${pnpmVersion} --ignore-scripts --no-audit --no-fund`)
  ) {
    errors.push(`${label} must install pnpm without running registry package lifecycle scripts or audit requests.`);
  }
  const wranglerVersion = packageDependencyVersion(pkg, 'wrangler');
  if (toolsPackage?.private !== true) {
    errors.push('sandbox-tools/package.json must set private to true.');
  }
  if (toolsPackage?.license !== 'Apache-2.0') {
    errors.push('sandbox-tools/package.json must declare the repository Apache-2.0 license.');
  }
  if (toolsPackage?.engines?.node !== SANDBOX_NODE_ENGINE) {
    errors.push(
      `sandbox-tools/package.json must support the pinned Cloudflare Sandbox Node ${SANDBOX_NODE_ENGINE} runtime.`,
    );
  }
  if (toolsPackage?.packageManager !== packageManager) {
    errors.push(
      `sandbox-tools/package.json packageManager must match package.json ${packageManager ?? '<missing>'}; found ${toolsPackage?.packageManager ?? '<missing>'}.`,
    );
  }
  if (!wranglerVersion || toolsPackage?.dependencies?.wrangler !== wranglerVersion) {
    errors.push(
      `sandbox-tools/package.json must pin wrangler to package.json ${wranglerVersion ?? '<missing>'}; found ${toolsPackage?.dependencies?.wrangler ?? '<missing>'}.`,
    );
  }
  if (toolsPackage?.dependencies?.yaml !== SANDBOX_YAML_VERSION) {
    errors.push(
      `sandbox-tools/package.json must pin yaml ${SANDBOX_YAML_VERSION}; found ${toolsPackage?.dependencies?.yaml ?? '<missing>'}.`,
    );
  }
  if (
    !dockerfile.includes(
      'COPY sandbox-tools/package.json sandbox-tools/pnpm-lock.yaml sandbox-tools/pnpm-workspace.yaml sandbox-tools/verify-pnpm-workspace-policy.mjs /opt/ghostbuild-tools/',
    )
  ) {
    errors.push(`${label} must copy the sandbox tool manifest and lockfile into the image.`);
  }
  if (!dockerfile.includes('pnpm --dir /opt/ghostbuild-tools install --prod --frozen-lockfile')) {
    errors.push(`${label} must install sandbox tools from the frozen pnpm lockfile.`);
  }
  if (!dockerfile.includes('ENV PATH="/opt/ghostbuild-tools/node_modules/.bin:${PATH}"')) {
    errors.push(`${label} must expose lockfile-installed sandbox tools on PATH.`);
  }
  if (!dockerfile.includes('ghostbuild-verify-pnpm-workspace')) {
    errors.push(`${label} must install the trusted pnpm workspace policy validator.`);
  }
  if (wranglerVersion) {
    const escapedVersion = wranglerVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lockedImporter = new RegExp(
      `wrangler:\\s*\\n\\s*specifier: ${escapedVersion}\\s*\\n\\s*version: ${escapedVersion}(?:\\s|$)`,
    );
    if (!lockedImporter.test(toolsLockfile ?? '')) {
      errors.push(`sandbox-tools/pnpm-lock.yaml must lock wrangler ${wranglerVersion}.`);
    }
  }
  const escapedYamlVersion = SANDBOX_YAML_VERSION.replaceAll('.', '\\.');
  const lockedYamlImporter = new RegExp(
    `yaml:\\s*\\n\\s*specifier: ${escapedYamlVersion}\\s*\\n\\s*version: ${escapedYamlVersion}(?:\\s|$)`,
  );
  if (!lockedYamlImporter.test(toolsLockfile ?? '')) {
    errors.push(`sandbox-tools/pnpm-lock.yaml must lock yaml ${SANDBOX_YAML_VERSION}.`);
  }
  return errors;
}

function verifyWorkspace(errors) {
  const workspace = readFileSync(resolve(rootDir, 'pnpm-workspace.yaml'), 'utf8');
  for (const packagePath of ['ghostbuild-agent', 'template']) {
    if (!new RegExp(`- ['"]?${packagePath}['"]?`).test(workspace)) {
      errors.push(`pnpm-workspace.yaml must include ${packagePath}.`);
    }
  }
  const blockedWASQLite = /^  '@journeyapps\/wa-sqlite': false$/gm;
  const blockedWASQLiteEntries = workspace.match(blockedWASQLite) ?? [];
  if (blockedWASQLiteEntries.length !== 1) {
    errors.push("pnpm-workspace.yaml must explicitly block '@journeyapps/wa-sqlite' exactly once.");
  }
  errors.push(...findBuildApprovalErrors(workspace.replace(blockedWASQLite, ''), 'pnpm-workspace.yaml'));
  if (/set this to true or false/i.test(workspace)) {
    errors.push('pnpm-workspace.yaml must not contain unresolved build-approval placeholders.');
  }
}

function verifyToolchainConfig(errors, rootPackage) {
  const nodeVersion = readFileSync(resolve(rootDir, '.nvmrc'), 'utf8').trim();
  if (nodeVersion !== '26.3.0') {
    errors.push('.nvmrc must pin Node.js 26.3.0.');
  }
  if (rootPackage?.packageManager !== 'pnpm@11.14.0') {
    errors.push('package.json must pin pnpm 11.14.0 for Cloudflare Workers Builds.');
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
  if (
    !/INSERT\s+OR\s+IGNORE\s+INTO\s+agent_gc_candidates/i.test(sql) ||
    !/JOIN\s+chat_transcripts/i.test(sql) ||
    !/max_generation/i.test(sql)
  ) {
    errors.push('root migrations must queue every deleted chat transcript generation range for Agent cleanup.');
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
    ...findInternalPackageMetadataErrors(rootPackage, 'package.json'),
    ...findInternalPackageMetadataErrors(agentPackage, 'ghostbuild-agent/package.json'),
    ...findInternalPackageMetadataErrors(templatePackage, 'template/package.json'),
    ...findPackageVersionAlignmentErrors(
      rootPackage,
      agentPackage,
      'ghostbuild-agent/package.json',
      agentRequiredPackages,
    ),
    ...findPackageVersionAlignmentErrors(rootPackage, templatePackage, 'template/package.json', APP_REQUIRED_PACKAGES),
    ...findForbiddenFiles(forbiddenLockfiles),
    ...findForbiddenDependencyUpdateConfigs(forbiddenDependencyUpdateConfigs),
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
      'verify:licenses',
      'typecheck',
      'lint',
      'test',
      'knip',
      'build',
      'verify:static-assets',
      'bundle:check',
    ]),
    ...findMissingCommandSteps(rootPackage.scripts?.['validate:template'], 'package.json scripts.validate:template', [
      'scripts/verify-template.mjs',
    ]),
  );

  verifyWorkspace(errors);
  verifyToolchainConfig(errors, rootPackage);
  verifyRootMigrations(errors);
  errors.push(...verifyD1MigrationSafety(rootDir));
  errors.push(
    ...findSandboxVersionErrors(
      rootPackage,
      readFileSync(resolve(rootDir, 'Dockerfile.sandbox'), 'utf8'),
      readJson('sandbox-tools/package.json'),
      readFileSync(resolve(rootDir, 'sandbox-tools/pnpm-lock.yaml'), 'utf8'),
    ),
    ...findWorkspacePolicyErrors(
      readFileSync(resolve(rootDir, 'sandbox-tools/pnpm-workspace.yaml'), 'utf8'),
      new Set(['esbuild', 'sharp', 'workerd']),
    ).map((error) => `sandbox-tools/${error}`),
    ...findDeploymentWorkflowErrors(
      readFileSync(resolve(rootDir, 'app/lib/.server/cloudflare/deployment-workflow.ts'), 'utf8'),
    ),
    ...findDeploymentRuntimePolicyErrors(
      readFileSync(resolve(rootDir, 'template/wrangler.jsonc'), 'utf8'),
      readFileSync(resolve(rootDir, 'app/lib/.server/cloudflare/deployment-runtime-policy.ts'), 'utf8'),
    ),
  );

  const snapshots = collectSnapshots();
  errors.push(
    ...findTemplateSnapshotErrors(
      snapshots,
      readFileSync(resolve(rootDir, 'app/lib/stores/startup/useContainerSetup.ts'), 'utf8'),
      snapshotHashes(snapshots),
    ),
  );
  if (snapshots.length === 1) {
    const sourceSha256 = templateSourceDigest(rootDir);
    errors.push(
      ...findTemplateSnapshotManifestErrors(
        readJson('public/template-snapshot-manifest.json'),
        snapshots[0],
        sourceSha256,
      ),
      ...findBuilderTemplateModuleErrors(
        readFileSync(resolve(rootDir, 'app/agents/builder-template.generated.ts'), 'utf8'),
        sourceSha256,
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
