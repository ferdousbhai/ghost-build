import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const forbiddenDependencyPatterns = [
  /^convex$/,
  /^@convex\//,
  /^remix$/,
  /^@remix-run\//,
  /^openai$/,
  /^@openai\//,
  /^anthropic$/,
  /^@anthropic-ai\/sdk$/,
  /^@google\/genai$/,
  /^@google\/generative-ai$/,
  /^@ai-sdk\/(?!provider$|react$)[^/]+$/,
  /^groq-sdk$/,
  /^@mistralai\/mistralai$/,
  /^@types\/diff$/,
];

const forbiddenImportPatterns = [
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:convex(?:\/[^'"]*)?|@convex\/[^'"]*)['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:remix(?:\/[^'"]*)?|@remix-run\/[^'"]*)['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:openai(?:\/[^'"]*)?|@openai\/[^'"]*)['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:anthropic(?:\/[^'"]*)?|@anthropic-ai\/sdk)['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:@google\/genai|@google\/generative-ai)['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"]@ai-sdk\/(?!provider(?:\/|['"])|react(?:\/|['"]))[^'"]*['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:groq-sdk|@mistralai\/mistralai)['"]/,
];

const forbiddenRuntimeEnvAccessPatterns = [/\bprocess\.env\b/, /\bimport\.meta\.env\b/];
const runtimeEnvAccessAllowlist = [
  {
    pathSuffix: 'app/lib/webcontainer/index.ts',
    snippet: 'import.meta.env.SSR',
  },
];

const appRequiredPackages = [
  '@ai-sdk/provider',
  '@ai-sdk/react',
  '@cloudflare/ai-chat',
  '@cloudflare/vite-plugin',
  '@tanstack/db',
  '@tanstack/query-db-collection',
  '@tanstack/react-db',
  '@tanstack/react-query',
  '@tanstack/react-router',
  '@tanstack/react-start',
  '@tanstack/router-cli',
  '@vitejs/plugin-react',
  'agents',
  'ai',
  'react',
  'react-dom',
  'typescript',
  'vite',
  'workers-ai-provider',
  'wrangler',
  'zod',
];
const agentRequiredPackages = ['ai', 'zod'];
const cloudflareAiPeerPackages = ['agents', '@cloudflare/ai-chat', 'workers-ai-provider'];
const cloudflareAiPeerRequirements = [
  {
    packageName: 'ai',
    expectedPrefix: '^6.',
    peerRange: '^6.0.0',
  },
  {
    packageName: '@ai-sdk/react',
    expectedPrefix: '^3.',
    peerRange: '^3.0.204',
  },
  {
    packageName: '@ai-sdk/provider',
    expectedPrefix: '^3.',
    peerRange: '^3.0.0',
  },
];
const optionalWorkerStringBindings = [
  'CLOUDFLARE_SITE_URL',
  'AXIOM_API_TOKEN',
  'AXIOM_API_URL',
  'AXIOM_DATASET_NAME',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'POSTHOG_KEY',
  'POSTHOG_HOST',
  'SENTRY_DSN',
  'WORKERS_CI_COMMIT_SHA',
  'COMMIT_SHA',
  'GITHUB_SHA',
];
const publicRuntimeBindings = ['CLOUDFLARE_SITE_URL', 'POSTHOG_KEY', 'POSTHOG_HOST', 'SENTRY_DSN'];
const rootRequiredMigrationSnippets = [
  'CREATE TABLE IF NOT EXISTS "user"',
  'CREATE TABLE IF NOT EXISTS session',
  'CREATE TABLE IF NOT EXISTS account',
  'CREATE TABLE IF NOT EXISTS verification',
  'CREATE TABLE IF NOT EXISTS chats',
  'CREATE INDEX IF NOT EXISTS idx_chats_creator_initial_deleted',
  'CREATE TABLE IF NOT EXISTS chat_message_states',
  'CREATE INDEX IF NOT EXISTS idx_chat_message_states_chat',
  'CREATE TABLE IF NOT EXISTS shares',
  'CREATE INDEX IF NOT EXISTS idx_shares_code',
  'CREATE TABLE IF NOT EXISTS social_shares',
  'CREATE INDEX IF NOT EXISTS idx_social_shares_code',
];
const templateRequiredMigrationSnippets = [
  'CREATE TABLE IF NOT EXISTS decisions',
  'INSERT OR IGNORE INTO decisions',
  'TanStack Start, TanStack DB, TanStack Query, Cloudflare Workers, D1, R2, Workers AI, and Agents.',
];
const forbiddenLockfiles = ['package-lock.json', 'template/package-lock.json'];
const forbiddenLegacyPaths = [
  '.cursor/rules/convex_rules.mdc',
  'app/components/convex',
  'app/components/chat/ChefAuthWrapper.tsx',
  'app/components/chat/ModelSelector.tsx',
  'app/components/DebugPromptView.tsx',
  'app/components/debug/DraggableDebugView.tsx',
  'app/components/debug/UsageDebugView.tsx',
  'app/components/debug/UsageBreakdownView.tsx',
  'app/components/header/PromptDebugButton.tsx',
  'app/components/header/ReferButton.tsx',
  'app/components/admin/PromptDebugContent.client.tsx',
  'app/components/admin/UsageBreakdownContent.client.tsx',
  'app/components/settings/ApiKeyCard.tsx',
  'app/lib/.server/llm/convex-agent.ts',
  'app/lib/.server/llm/provider.spec.ts',
  'app/lib/cloudflare/workspace.ts',
  'app/lib/convexOptins.ts',
  'app/lib/convexProfile.ts',
  'app/lib/convexProvisionHost.ts',
  'app/lib/convexSiteUrl.ts',
  'app/lib/convexUsage.ts',
  'app/lib/download/convex_rules.mdc',
  'app/lib/download/setupMjsContent.ts',
  'app/lib/stores/convexProject.ts',
  'app/lib/stores/convexTeams.ts',
  'app/lib/stores/debug.ts',
  'app/routes/api.convex.callback.ts',
  'app/routes/admin.prompt-debug.tsx',
  'app/routes/admin.usage-breakdown.tsx',
  'app/routes/convex.callback.tsx',
  'app/routes/convex.connect.tsx',
  'chef-agent',
  'chefshot',
  'convex',
  'patches/@ai-sdk__openai@1.3.6.patch',
  'public/chef.svg',
  'public/icons/claude.svg',
  'public/icons/gemini.svg',
  'public/icons/openai.svg',
  'public/landing/anthropic.svg',
  'public/landing/google.svg',
  'public/landing/openAI.svg',
  'public/landing/xAI.svg',
  'template/convex',
  'test-kitchen',
];
const requiredNodeEngine = '>=26.0.0';
const requiredNodeVersion = '26.3.0';
const requiredPnpmVersion = '9.5.0';
const templateSnapshotPattern = /^template-snapshot-([a-f0-9]{8})\.bin$/;

const sourceExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const ignoredDirectories = new Set([
  '.git',
  '.turbo',
  '.wrangler',
  'dist',
  'fixtures',
  'node_modules',
  'worker-configuration.d.ts',
]);

export function dependencyNames(pkg) {
  return new Set(
    dependencySections.flatMap((section) => {
      const values = pkg?.[section];
      return values && typeof values === 'object' ? Object.keys(values) : [];
    }),
  );
}

export function findForbiddenDependencies(pkg, label) {
  return [...dependencyNames(pkg)]
    .filter((name) => forbiddenDependencyPatterns.some((pattern) => pattern.test(name)))
    .map((name) => `${label} must not depend on ${name}; use Cloudflare Workers AI and TanStack/Cloudflare APIs.`);
}

export function findMissingDependencies(pkg, label, requiredPackages) {
  const names = dependencyNames(pkg);
  return requiredPackages
    .filter((name) => !names.has(name))
    .map((name) => `${label} must include ${name} for the TanStack Start + Cloudflare stack.`);
}

export function packageDependencyVersion(pkg, name) {
  for (const section of dependencySections) {
    const version = pkg?.[section]?.[name];
    if (typeof version === 'string') {
      return version;
    }
  }
  return undefined;
}

export function findPackageVersionAlignmentErrors(referencePkg, pkg, label, packageNames) {
  return packageNames.flatMap((name) => {
    const expected = packageDependencyVersion(referencePkg, name);
    const actual = packageDependencyVersion(pkg, name);
    if (!expected || !actual || actual === expected) {
      return [];
    }
    return [`${label} must align ${name} with package.json ${expected}; found ${actual}.`];
  });
}

export function findCloudflareAiPeerCompatibilityErrors(pkg, label) {
  const installedCloudflarePeerPackages = cloudflareAiPeerPackages.filter((name) =>
    packageDependencyVersion(pkg, name),
  );
  if (installedCloudflarePeerPackages.length === 0) {
    return [];
  }

  return cloudflareAiPeerRequirements.flatMap(({ packageName, expectedPrefix, peerRange }) => {
    const version = packageDependencyVersion(pkg, packageName);
    if (!version || version.startsWith(expectedPrefix)) {
      return [];
    }

    return [
      `${label} must keep ${packageName} on ${expectedPrefix}x while ${installedCloudflarePeerPackages.join(
        ', ',
      )} require ${packageName} ${peerRange}; found ${version}.`,
    ];
  });
}

export function findForbiddenFiles(paths) {
  return paths
    .filter((path) => existsSync(resolve(rootDir, path)))
    .map((path) => `${path} must not exist; Ghostbuild uses pnpm lockfiles only.`);
}

export function findForbiddenLegacyPaths(paths) {
  return paths
    .filter((path) => existsSync(resolve(rootDir, path)))
    .map((path) => `${path} must not exist; Ghostbuild uses TanStack Start and Cloudflare-only providers.`);
}

export function findRuntimePinErrors(pkg, label) {
  const errors = [];
  const nodeEngine = pkg?.engines?.node;
  const packageManager = pkg?.packageManager;
  const nodeTypes = pkg?.devDependencies?.['@types/node'];

  if (nodeEngine !== requiredNodeEngine) {
    errors.push(`${label} must set engines.node to ${requiredNodeEngine}.`);
  }

  if (packageManager !== `pnpm@${requiredPnpmVersion}`) {
    errors.push(`${label} must pin packageManager to pnpm@${requiredPnpmVersion}.`);
  }

  if (!nodeTypes?.startsWith('^26.')) {
    errors.push(`${label} must use @types/node ^26.x for the Node 26 toolchain.`);
  }

  return errors;
}

export function findTemplateSnapshotErrors(snapshotFiles, setupContent, hashByFile = new Map()) {
  const errors = [];
  const snapshotNames = snapshotFiles.map((file) => file.split('/').pop() ?? file).sort();

  if (snapshotNames.length !== 1) {
    errors.push(
      `public must contain exactly one template-snapshot-*.bin file; found ${snapshotNames.length || 'none'}.`,
    );
    return errors;
  }

  const [snapshotName] = snapshotNames;
  const match = templateSnapshotPattern.exec(snapshotName);
  if (!match) {
    errors.push(`${snapshotName} must match template-snapshot-<8 hex chars>.bin.`);
    return errors;
  }

  const expectedUrl = `/${snapshotName}`;
  if (!setupContent.includes(`const TEMPLATE_URL = '${expectedUrl}';`)) {
    errors.push(`app/lib/stores/startup/useContainerSetup.ts must reference ${expectedUrl}.`);
  }

  const actualHash = hashByFile.get(snapshotName);
  if (actualHash && actualHash !== match[1]) {
    errors.push(`${snapshotName} hash must match its compressed snapshot content; expected ${actualHash}.`);
  }

  return errors;
}

export function findForbiddenImports(files) {
  const errors = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      if (forbiddenImportPatterns.some((pattern) => pattern.test(line))) {
        errors.push(`${file}:${index + 1} imports a forbidden provider/framework module.`);
      }
    });
  }

  return errors;
}

export function findForbiddenRuntimeEnvAccess(files, allowlist = runtimeEnvAccessAllowlist) {
  const errors = [];

  for (const file of files) {
    const normalizedFile = file.replaceAll('\\', '/');
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      if (!forbiddenRuntimeEnvAccessPatterns.some((pattern) => pattern.test(line))) {
        return;
      }

      const isAllowed = allowlist.some(
        ({ pathSuffix, snippet }) => normalizedFile.endsWith(pathSuffix) && line.includes(snippet),
      );
      if (isAllowed) {
        return;
      }

      errors.push(
        `${file}:${index + 1} must read runtime config from Cloudflare Worker bindings, not process.env or import.meta.env.`,
      );
    });
  }

  return errors;
}

function verifyPackagePolicy(errors, pkg, target) {
  const { label, requiredPackages, checkCloudflareAiPeers = false } = target;

  errors.push(...findForbiddenDependencies(pkg, label));
  errors.push(...findMissingDependencies(pkg, label, requiredPackages));
  if (checkCloudflareAiPeers) {
    errors.push(...findCloudflareAiPeerCompatibilityErrors(pkg, label));
  }
  errors.push(...findRuntimePinErrors(pkg, label));
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(rootDir, path), 'utf8'));
}

function collectSourceFiles(directory) {
  const absoluteDirectory = resolve(rootDir, directory);
  const files = [];

  function visit(path) {
    const name = path.split('/').pop();
    if (name && ignoredDirectories.has(name)) {
      return;
    }

    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path)) {
        visit(join(path, child));
      }
      return;
    }

    if (sourceExtensions.has(extname(path))) {
      files.push(path);
    }
  }

  visit(absoluteDirectory);
  return files;
}

function collectSourceEntries(entries) {
  return entries.flatMap((entry) => {
    const absoluteEntry = resolve(rootDir, entry);
    if (!existsSync(absoluteEntry)) {
      return [];
    }

    const stat = statSync(absoluteEntry);
    if (stat.isDirectory()) {
      return collectSourceFiles(entry);
    }

    return sourceExtensions.has(extname(absoluteEntry)) ? [absoluteEntry] : [];
  });
}

function requireFileContains(errors, path, expected) {
  const content = readFileSync(resolve(rootDir, path), 'utf8');
  if (!content.includes(expected)) {
    errors.push(`${path} must contain ${expected}.`);
  }
}

function requireFileContainsInOrder(errors, path, expectedValues) {
  const content = readFileSync(resolve(rootDir, path), 'utf8');
  let cursor = -1;

  for (const expected of expectedValues) {
    const index = content.indexOf(expected, cursor + 1);
    if (index === -1) {
      errors.push(`${path} must contain ${expected} after the previous required value.`);
      return;
    }
    cursor = index;
  }
}

function requireFileExcludes(errors, path, forbidden) {
  const content = readFileSync(resolve(rootDir, path), 'utf8');
  if (content.includes(forbidden)) {
    errors.push(`${path} must not contain ${forbidden}.`);
  }
}

function requireRootMigrationsContain(errors, expected) {
  const migrationDir = resolve(rootDir, 'migrations');
  const content = readdirSync(migrationDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(resolve(migrationDir, file), 'utf8'))
    .join('\n');

  if (!content.includes(expected)) {
    errors.push(`root migrations must contain ${expected}.`);
  }
}

function requirePathAbsent(errors, path) {
  if (existsSync(resolve(rootDir, path))) {
    errors.push(`${path} must not exist.`);
  }
}

function requireExactFileContent(errors, path, expected) {
  const content = readFileSync(resolve(rootDir, path), 'utf8').trim();
  if (content !== expected) {
    errors.push(`${path} must contain exactly ${expected}.`);
  }
}

function collectTemplateSnapshotFiles() {
  return readdirSync(resolve(rootDir, 'public')).filter((file) => /^template-snapshot-.*\.bin$/.test(file));
}

function hashSnapshotFiles(files) {
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
  const packageTargets = [
    {
      pkg: readJson('package.json'),
      label: 'package.json',
      requiredPackages: appRequiredPackages,
      checkCloudflareAiPeers: true,
    },
    {
      pkg: readJson('ghostbuild-agent/package.json'),
      label: 'ghostbuild-agent/package.json',
      requiredPackages: agentRequiredPackages,
    },
    {
      pkg: readJson('template/package.json'),
      label: 'template/package.json',
      requiredPackages: appRequiredPackages,
      checkCloudflareAiPeers: true,
    },
  ];

  for (const target of packageTargets) {
    verifyPackagePolicy(errors, target.pkg, target);
  }
  const rootPackage = packageTargets[0].pkg;
  errors.push(
    ...findPackageVersionAlignmentErrors(
      rootPackage,
      packageTargets[1].pkg,
      packageTargets[1].label,
      agentRequiredPackages,
    ),
    ...findPackageVersionAlignmentErrors(
      rootPackage,
      packageTargets[2].pkg,
      packageTargets[2].label,
      appRequiredPackages,
    ),
  );
  errors.push(...findForbiddenFiles(forbiddenLockfiles));
  errors.push(...findForbiddenLegacyPaths(forbiddenLegacyPaths));
  if (rootPackage.license !== 'Apache-2.0') {
    errors.push('package.json must declare Apache-2.0 licensing.');
  }
  const templateSnapshotFiles = collectTemplateSnapshotFiles();
  errors.push(
    ...findTemplateSnapshotErrors(
      templateSnapshotFiles,
      readFileSync(resolve(rootDir, 'app/lib/stores/startup/useContainerSetup.ts'), 'utf8'),
      hashSnapshotFiles(templateSnapshotFiles),
    ),
  );

  const sourceFiles = {
    app: collectSourceEntries(['app']),
    rootScripts: collectSourceEntries(['scripts']),
    rootViteConfig: collectSourceEntries(['vite.config.ts']),
    agent: collectSourceEntries(['ghostbuild-agent']),
    templateSrc: collectSourceEntries(['template/src']),
    templateScripts: collectSourceEntries(['template/scripts']),
    templateViteConfig: collectSourceEntries(['template/vite.config.ts']),
  };

  errors.push(...findForbiddenImports([...sourceFiles.app, ...sourceFiles.rootScripts, ...sourceFiles.rootViteConfig]));
  errors.push(...findForbiddenImports(sourceFiles.agent));
  errors.push(
    ...findForbiddenImports([
      ...sourceFiles.templateSrc,
      ...sourceFiles.templateScripts,
      ...sourceFiles.templateViteConfig,
    ]),
  );
  errors.push(
    ...findForbiddenRuntimeEnvAccess([
      ...sourceFiles.app,
      ...sourceFiles.templateSrc,
      ...sourceFiles.rootViteConfig,
      ...sourceFiles.templateViteConfig,
    ]),
  );

  requireFileContains(errors, 'app/lib/workers-ai-model.ts', "CLOUDFLARE_WORKERS_AI_MODEL = '@cf/zai-org/glm-5.2'");
  requireFileExcludes(errors, 'app/lib/workers-ai-model.ts', 'DEFAULT_MODEL_SELECTION');
  requireFileExcludes(errors, 'app/lib/workers-ai-model.ts', 'ModelSelection');
  requireFileContains(errors, 'app/lib/.server/llm/provider.ts', "from '~/lib/workers-ai-model'");
  requireFileContains(errors, 'app/lib/.server/llm/provider.ts', 'model: cloudflare(CLOUDFLARE_WORKERS_AI_MODEL)');
  requireFileExcludes(errors, 'app/lib/.server/llm/provider.ts', 'workersAiModel');
  requireFileExcludes(errors, 'app/lib/.server/llm/provider.ts', 'SUPPORTED_CALLER_MODELS');
  requireFileContains(errors, 'app/lib/.server/llm/workers-ai-agent.ts', 'promptMessages?: Messages');
  requireFileContains(errors, 'app/lib/.server/llm/workers-ai-agent.ts', 'promptMessages = messages');
  requireFileContains(errors, 'app/lib/.server/llm/workers-ai-agent.ts', 'cleanupAssistantMessages(promptMessages');
  requireFileContains(errors, 'app/lib/.server/llm/workers-ai-agent.ts', 'asAiSdkTools(tools)');
  requireFileContains(errors, 'app/lib/.server/llm/workers-ai-agent.ts', 'abortSignal?: AbortSignal');
  requireFileContains(errors, 'app/lib/.server/llm/workers-ai-agent.ts', 'abortSignal,');
  requireFileContains(
    errors,
    'app/lib/.server/llm/workers-ai-agent.ts',
    'originalMessages: asOriginalMessages(messages)',
  );
  requireFileContains(errors, 'app/lib/.server/llm/message-conversion.ts', 'convertToModelMessages');
  requireFileExcludes(errors, 'ghostbuild-agent/ai-compat.ts', 'convertToModelMessages');
  requireFileExcludes(errors, 'app/lib/.server/llm/workers-ai-agent.ts', 'tools as any');
  requireFileExcludes(errors, 'app/lib/.server/llm/workers-ai-agent.ts', 'messages as any');
  requireFileContains(errors, 'app/lib/.server/llm/workers-ai-agent.ts', 'cachedPromptTokens(providerMetadata)');
  requireFileExcludes(errors, 'app/lib/.server/llm/workers-ai-agent.ts', 'providerMetadata.openai');
  requireFileContains(errors, 'app/lib/.server/chat.ts', 'const transcriptMessages = messages ?? [];');
  requireFileContains(
    errors,
    'app/lib/.server/chat.ts',
    'const modelMessages = body.preparedMessages ?? transcriptMessages;',
  );
  requireFileContains(errors, 'app/lib/.server/chat.ts', 'promptMessages: modelMessages');
  requireFileExcludes(errors, 'app/lib/.server/chat.ts', 'Invalid or missing API key');
  requireFileContains(errors, 'tsconfig.json', '"extends": "agents/tsconfig"');
  requireFileContains(errors, 'vite.config.ts', "import agents from 'agents/vite';");
  requireFileContains(errors, 'vite.config.ts', 'agents()');
  requireFileContains(errors, 'vite.config.ts', "cloudflare({ viteEnvironment: { name: 'ssr' } })");
  requireFileContains(errors, 'vite.config.ts', 'tanstackStart({');
  requireFileContains(errors, 'app/server.ts', "import handler from '@tanstack/react-start/server-entry';");
  requireFileContains(errors, 'app/server.ts', "import { routeAgentRequest } from 'agents';");
  requireFileContains(errors, 'app/server.ts', "export { BuilderAgent } from './agents/builder-agent';");
  requireFileContains(errors, 'app/server.ts', 'const agentResponse = await routeAgentRequest(request, env);');
  requireFileContains(errors, 'app/server.ts', 'return handler.fetch(request);');
  requireFileContains(errors, 'app/server.ts', 'const exactRoutes: Record<string, ServerRoute>');
  requireFileContains(errors, 'app/server.ts', "'/api/health':");
  requireFileContains(errors, 'app/server.ts', "'/api/public-config':");
  requireFileContains(errors, 'app/server.ts', 'const route = exactRoutes[url.pathname];');
  requireFileContainsInOrder(errors, 'app/server.ts', [
    'const agentResponse = await routeAgentRequest(request, env);',
    'const route = exactRoutes[url.pathname];',
    'return handler.fetch(request);',
  ]);
  requireFileExcludes(errors, 'app/server.ts', "if (url.pathname === '/api/chat')");
  requireFileContains(errors, 'app/agents/builder-agent.ts', "from '@cloudflare/ai-chat'");
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'AIChatAgent,');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'export class BuilderAgent extends AIChatAgent<Env');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'static override options');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'sendIdentityOnConnect: false');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'override chatRecovery');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'override maxPersistedMessages = 200');
  requireFileContains(errors, 'app/agents/builder-agent.ts', "override messageConcurrency = 'queue' as const");
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'override waitForMcpConnections = { timeout: 10_000 }');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'terminalMessage:');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'override chatStreamStallTimeoutMs = 60_000');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'override async onChatRecovery');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'override async onChatMessage');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'abortSignal?: AbortSignal');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'abortSignal: options?.abortSignal');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'options?.continuation');
  requireFileContains(
    errors,
    'app/agents/builder-agent.ts',
    "const messages = this.messages as NonNullable<ChatRequestBody['messages']>;",
  );
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'preparedMessages,');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'createChatResponseFromBody');
  requireFileContains(errors, 'app/agents/builder-agent.ts', '@callable()');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'this.sql`');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'this.setState(');
  requireFileContains(errors, 'app/agents/builder-agent.ts', "from '~/lib/workers-ai-model'");
  requireFileExcludes(errors, 'app/agents/builder-agent.ts', 'modelChoice');
  requireFileContains(errors, 'app/agents/builder-agent.ts', 'this.env.AI.run(CLOUDFLARE_WORKERS_AI_MODEL');
  requireFileContains(errors, 'app/components/chat/Chat.tsx', "from 'agents/react'");
  requireFileContains(errors, 'app/components/chat/Chat.tsx', "from '@cloudflare/ai-chat/react'");
  requireFileContains(errors, 'app/components/chat/Chat.tsx', 'useAgentChat<BuilderAgentState, UIMessage>');
  requireFileContains(errors, 'app/components/chat/Chat.tsx', 'preparedMessages');
  requireFileContains(errors, 'app/components/chat/Chat.tsx', 'isRecovering,');
  requireFileContains(errors, 'app/components/chat/Chat.tsx', "const streamStatus = isRecovering ? 'submitted'");
  requireFileContains(errors, 'app/components/chat/BaseChat.client.tsx', 'isRecovering: boolean;');
  requireFileContains(
    errors,
    'app/components/chat/StreamingIndicator.tsx',
    "recovering: 'Recovering interrupted response...'",
  );
  requireFileExcludes(errors, 'app/components/chat/Chat.tsx', "api: '/api/chat'");
  requireFileExcludes(errors, 'app/components/chat/Chat.tsx', "from '@ai-sdk/react'");
  requireFileExcludes(errors, 'app/components/chat/Chat.tsx', 'DefaultChatTransport');
  requireFileContains(errors, 'app/components/chat/Chat.tsx', 'toAiSdkMessageParts');
  requireFileContains(errors, 'app/lib/cloudflare/chat-history-db.ts', 'queryCollectionOptions<ChatHistorySummary>');
  requireFileContains(errors, 'app/lib/cloudflare/chat-history-db.ts', 'useLiveQuery(() => collection');
  requireFileContains(errors, 'app/lib/cloudflare/chat-history-db.ts', 'onDelete: async ({ transaction })');
  requireFileContains(errors, 'app/lib/cloudflare/chat-history-db.ts', 'transaction.mutations.map');
  requireFileContains(errors, 'app/lib/cloudflare/chat-history-db.ts', 'const tx = collection.delete(itemId');
  requireFileContains(errors, 'app/lib/cloudflare/chat-history-db.ts', 'await tx.isPersisted.promise');
  requireFileExcludes(errors, 'app/lib/cloudflare/chat-history-db.ts', 'utils.writeDelete');
  requireFileContains(errors, 'app/lib/cloudflare/data.server.ts', 'ensureDataBindings(env)');
  requireFileContains(errors, 'app/lib/cloudflare/data.server.ts', 'Cloudflare D1 binding DB is not configured');
  requireFileContains(
    errors,
    'app/lib/cloudflare/data.server.ts',
    'Cloudflare R2 binding APP_STORAGE is not configured',
  );
  for (const expected of rootRequiredMigrationSnippets) {
    requireRootMigrationsContain(errors, expected);
  }
  requirePathAbsent(errors, 'app/lib/runtime/deployToolOutputLabels.ts');
  requireFileContains(errors, 'app/lib/runtime/action-runner.ts', "['pnpm', 'run', 'deploy']");
  requireFileExcludes(errors, 'app/lib/runtime/action-runner.ts', 'outputLabels');
  requireFileContains(errors, 'package.json', 'tsc --ignoreConfig buildSystemPrompts.ts');
  requireFileContains(errors, 'package.json', '--types node');
  requireFileContains(errors, '.gitignore', 'ghostbuild-system-prompts.txt');
  requireFileContains(errors, 'LICENSE', 'ghostbuild.dev');
  requireFileContains(errors, 'LICENSE', 'Copyright 2026 ghostbuild.dev contributors.');
  requireFileContains(errors, 'LICENSE', 'Apache License');
  requireFileExcludes(errors, 'LICENSE', 'Chef');
  requireFileContains(errors, 'app/components/chat/ToolCall.tsx', 'Cloudflare deploy failed');
  requireFileContains(errors, 'ghostbuild-agent/tools/deploy.ts', 'run production linting');
  requireFileContains(errors, 'ghostbuild-agent/prompts/outputInstructions.ts', 'Run production linting.');
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', 'pnpm run lint');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'tanstackStart');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'tanstackQuery');
  requireFileContains(
    errors,
    'ghostbuild-agent/tools/lookupDocs.ts',
    'cloudflare({ viteEnvironment: { name: "ssr" } })',
  );
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'import { env } from "cloudflare:workers"');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'onInsert, onUpdate, or onDelete');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'transaction.mutations');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'await tx.isPersisted.promise');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'collection.utils.writeInsert');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'new_sqlite_classes');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', '@cloudflare/ai-chat AIChatAgent');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'pruneMessages');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'maxPersistedMessages');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'messageConcurrency = "queue"');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'waitForMcpConnections = { timeout: 10_000 }');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'sendIdentityOnConnect: false');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'options?.abortSignal');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'useAgentChat');
  requireFileContains(
    errors,
    'ghostbuild-agent/prompts/solutionConstraints.ts',
    '\\`onInsert\\`, \\`onUpdate\\`, or \\`onDelete\\`',
  );
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', '\\`tx.isPersisted.promise\\`');
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', '\\`collection.utils.writeInsert\\`');
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', '\\`src/workers-ai.shared.ts\\`');
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', '\\`AIChatAgent\\`');
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', '\\`pruneMessages\\`');
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', '\\`maxPersistedMessages\\`');
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', '\\`messageConcurrency = "queue"\\`');
  requireFileContains(
    errors,
    'ghostbuild-agent/prompts/solutionConstraints.ts',
    '\\`waitForMcpConnections = { timeout: 10_000 }\\`',
  );
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', 'sendIdentityOnConnect: false');
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', '\\`options?.abortSignal\\`');
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', '\\`cloudflare:workers\\`');
  requireFileContains(errors, 'ghostbuild-agent/tools/npmInstall.ts', 'Keep runtime, data, and AI dependencies inside');
  requireFileContains(errors, 'ghostbuild-agent/tools/npmInstall.ts', 'other non-Workers-AI provider SDKs');
  requireFileContains(errors, 'ghostbuild-agent/tools/npmInstall.ts', 'findForbiddenNpmInstallPackages');
  requireFileContains(errors, 'ghostbuild-agent/tools/npmInstall.ts', 'packageNameFromInstallSpec');
  requireFileContains(errors, 'ghostbuild-agent/tools/npmInstall.ts', 'pnpm flags are not allowed');
  requireFileContains(errors, 'ghostbuild-agent/tools/npmInstall.test.ts', '@ai-sdk/groq@latest');
  requireFileContains(errors, 'ghostbuild-agent/tools/npmInstall.test.ts', '@ai-sdk/amazon-bedrock');
  requireFileContains(errors, 'ghostbuild-agent/tools/npmInstall.test.ts', '@google/genai');
  requireFileContains(errors, 'ghostbuild-agent/tools/npmInstall.test.ts', 'model-sdk@npm:@anthropic-ai/sdk');
  requireFileContains(errors, 'ghostbuild-agent/utils/stackPolicy.ts', 'isForbiddenStackDependencyPackageName');
  requireFileContains(errors, 'ghostbuild-agent/utils/stackPolicy.ts', '^@ai-sdk\\/(?!provider$|react$)[^/]+$');
  requireFileContains(errors, 'app/utils/generatedPackageManifest.ts', 'assertValidGeneratedPackageJson');
  requireFileContains(errors, 'app/utils/generatedPackageManifest.ts', 'packageNameFromInstallSpec(versionSpec)');
  requireFileContains(errors, 'app/utils/generatedPackageManifest.spec.ts', 'npm:@anthropic-ai/sdk@latest');
  requireFileContains(errors, 'app/utils/generatedPackageManifest.spec.ts', '@ai-sdk/amazon-bedrock');
  requireFileContains(
    errors,
    'app/lib/runtime/action-runner.ts',
    'assertValidGeneratedPackageJson(relativePath, action.content)',
  );
  requireFileContainsInOrder(errors, 'app/lib/runtime/action-runner.ts', [
    'assertValidGeneratedPackageJson(relativePath, action.content)',
    "logger.error('Failed to write file\\n\\n', error);",
    'throw error;',
  ]);
  requireFileContains(errors, 'app/lib/runtime/action-runner.ts', 'assertValidGeneratedPackageJson(relPath, content)');
  requireFileContains(errors, 'app/lib/stores/files.ts', 'assertValidGeneratedPackageJson(relativePath, content)');
  requireFileContains(errors, 'ghostbuild-agent/prompts/workersAiGuidelines.ts', '@cloudflare/ai-chat/react');
  requireFileContains(errors, 'ghostbuild-agent/prompts/workersAiGuidelines.ts', '\\`pruneMessages\\`');
  requireFileContains(errors, 'ghostbuild-agent/prompts/workersAiGuidelines.ts', '\\`maxPersistedMessages\\`');
  requireFileContains(errors, 'ghostbuild-agent/prompts/workersAiGuidelines.ts', '\\`messageConcurrency = "queue"\\`');
  requireFileContains(
    errors,
    'ghostbuild-agent/prompts/workersAiGuidelines.ts',
    '\\`waitForMcpConnections = { timeout: 10_000 }\\`',
  );
  requireFileContains(errors, 'ghostbuild-agent/prompts/workersAiGuidelines.ts', 'sendIdentityOnConnect: false');
  requireFileContains(errors, 'ghostbuild-agent/prompts/workersAiGuidelines.ts', '\\`options?.abortSignal\\`');
  requireFileExcludes(errors, 'ghostbuild-agent/types.ts', 'SystemPromptOptions');
  requireFileExcludes(errors, 'buildSystemPrompts.ts', 'defaultOptions');
  requireFileExcludes(errors, 'app/lib/.server/llm/workers-ai-agent.ts', 'SystemPromptOptions');
  requireFileExcludes(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', 'includeTemplate');
  requireFileExcludes(errors, 'ghostbuild-agent/prompts/outputInstructions.ts', 'enableBulkEdits');
  requireFileExcludes(errors, 'ghostbuild-agent/types.ts', 'enableEmailGuidance');
  requireFileExcludes(errors, 'ghostbuild-agent/types.ts', 'enableResend');
  requireFileExcludes(errors, 'buildSystemPrompts.ts', 'enableEmailGuidance');
  requireFileExcludes(errors, 'buildSystemPrompts.ts', 'enableResend');
  requireFileContains(errors, 'ghostbuild-agent/prompts/system.ts', 'emailGuidelines()');
  requireFileContains(errors, 'ghostbuild-agent/prompts/emailGuidelines.ts', 'avoid bundling a default');
  requireFileExcludes(errors, 'ghostbuild-agent/prompts/emailGuidelines.ts', 'enableEmailGuidance');
  requireFileContains(errors, 'ghostbuild-agent/prompts/emailGuidelines.ts', 'Cloudflare Worker secret binding');
  requireFileContains(errors, 'ghostbuild-agent/prompts/emailGuidelines.ts', 'Do not write local env files');
  requireFileExcludes(errors, 'ghostbuild-agent/prompts/emailGuidelines.ts', 'Resend API');
  requireFileExcludes(errors, 'ghostbuild-agent/prompts/emailGuidelines.ts', 'RESEND_API_KEY');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'pnpm run cf-typegen');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'pnpm run verify:stack');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'pnpm run lint');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'runs production linting');
  requireFileContains(
    errors,
    'app/lib/download/readmeContent.ts',
    'Deploy directly to the production Cloudflare Worker',
  );
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'Use Wrangler OAuth for local production deploys');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'as GitHub Actions secrets for CI authentication');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'Workers AI uses the Cloudflare \\`AI\\` binding');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'does not need model-provider API keys');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'import \\`env\\` from \\`cloudflare:workers\\`');
  requireFileContains(
    errors,
    'app/lib/download/readmeContent.ts',
    'Runtime secrets and variables belong in Cloudflare Worker bindings',
  );
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'messageConcurrency = "queue"');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'waitForMcpConnections = { timeout: 10_000 }');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', '\\`options?.abortSignal\\`');
  requireFileContains(errors, 'app/lib/download/cursorRulesContent.ts', 'pnpm run verify:stack');
  requireFileContains(errors, 'app/lib/download/cursorRulesContent.ts', 'import env from cloudflare:workers');
  requireFileContains(errors, 'app/lib/download/cursorRulesContent.ts', 'sendIdentityOnConnect: false');
  requireFileContains(errors, 'app/lib/download/cursorRulesContent.ts', 'messageConcurrency = "queue"');
  requireFileContains(errors, 'app/lib/download/cursorRulesContent.ts', 'waitForMcpConnections = { timeout: 10_000 }');
  requireFileContains(errors, 'app/lib/download/cursorRulesContent.ts', 'options?.abortSignal');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'sendIdentityOnConnect: false');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'diagnostics-channel events');
  requireFileContains(errors, 'app/lib/download/cursorRulesContent.ts', 'Cloudflare Tail Worker');
  requireFileContains(errors, 'app/lib/download/readmeContent.ts', 'traces \\`head_sampling_rate\\` to \\`0.05\\`');
  requireFileContains(errors, 'app/lib/download/cursorRulesContent.ts', 'observability.traces.enabled');
  requireFileContains(errors, 'app/lib/download/cursorRulesContent.ts', 'local dev-server deployment paths');
  requireFileContains(
    errors,
    'app/lib/download/cursorRulesContent.ts',
    'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN as production deploy credentials only',
  );
  requireFileContains(errors, '.gitignore', '.env');
  requireFileContains(errors, '.gitignore', '.env.*');
  requireFileContains(errors, '.gitignore', '.envrc');
  requireFileContains(errors, '.gitignore', '.dev.vars');
  requireFileContains(errors, '.gitignore', '.dev.vars.*');
  requireFileContains(errors, 'template/.gitignore', '.env*');
  requireFileContains(errors, 'template/.gitignore', '.envrc');
  requireFileContains(errors, 'template/.gitignore', '.dev.vars*');
  requireFileContains(errors, 'app/utils/secretFiles.ts', "'.envrc'");
  requireFileContains(errors, 'app/utils/secretFiles.ts', "segment.startsWith('.dev.vars.')");
  requireFileContains(errors, 'app/utils/secretFiles.ts', 'Use Cloudflare Worker bindings or wrangler secret put NAME');
  requireFileContains(errors, 'app/utils/productionShellPolicy.ts', 'findForbiddenProductionShellCommand');
  requireFileContains(errors, 'app/utils/productionShellPolicy.ts', 'wrangler\\s+(?:pages\\s+)?dev');
  requireFileContains(
    errors,
    'app/utils/productionShellPolicy.ts',
    'Deploy directly to the production Cloudflare Worker',
  );
  requireFileContains(errors, 'app/utils/productionShellPolicy.spec.ts', 'pnpm run dev');
  requireFileContains(errors, 'app/utils/productionShellPolicy.spec.ts', 'npx vite');
  requireFileContains(errors, 'app/utils/shell.ts', 'createProductionShellInputGuard');
  requireFileContains(errors, 'app/utils/shell.ts', 'assertProductionShellCommandAllowed(command)');
  requireFileContains(errors, 'app/utils/shell.ts', 'findForbiddenProductionShellCommand(commandBuffer)');
  requireFileContains(errors, 'app/lib/runtime/action-runner.ts', 'assertNotLocalSecretFilePath(relativePath)');
  requireFileContains(errors, 'app/lib/runtime/action-runner.ts', 'assertNotLocalSecretFilePath(relPath)');
  requireFileContains(errors, 'app/lib/stores/files.ts', 'assertNotLocalSecretFilePath(relativePath)');
  requireFileContains(errors, 'app/lib/stores/files.ts', 'isLocalSecretFilePath(absPath)');
  requireFileContains(errors, 'app/lib/stores/files.ts', 'isLocalSecretFilePath(sanitizedPath)');
  requireFileContains(errors, 'app/lib/stores/files.ts', '#removeLocalSecretFile(filePath: string)');
  requireFileContains(
    errors,
    'app/lib/stores/files.ts',
    'webcontainer.fs.rm(relativePath, { recursive: true, force: true })',
  );
  requireFileContains(errors, 'app/lib/stores/workbench.client.ts', 'isLocalSecretFilePath(relativePath)');
  requireFileContains(errors, 'app/lib/stores/workbench.client.ts', "path.join(WORK_DIR, 'src/workers-ai.shared.ts')");
  requireFileExcludes(errors, 'app/lib/stores/workbench.client.ts', "path.join(WORK_DIR, 'src/workers-ai.ts')");
  requireFileContains(errors, 'app/utils/secretFiles.ts', 'LOCAL_SECRET_FILE_IGNORE_PATHS');
  requireFileContains(errors, 'app/utils/secretFiles.ts', "'.dev.vars.'");
  requireFileContains(errors, 'app/utils/constants.ts', 'LOCAL_SECRET_FILE_IGNORE_PATHS');
  requireFileContains(errors, 'app/lib/.server/env.ts', 'type EnvKey = keyof Env & string');
  requireFileContains(errors, 'app/lib/.server/env.ts', "typeof value === 'string'");
  requireFileContains(errors, 'app/server.ts', "'/api/public-config':");
  requireFileContains(errors, 'app/lib/publicConfig.ts', "fetch('/api/public-config'");
  requireFileContains(errors, 'app/lib/publicConfig.ts', 'sentry:');
  requireFileContains(errors, 'app/components/AppProviders.client.tsx', 'initTelemetry(publicConfig)');
  requireFileContains(errors, 'app/lib/telemetry.client.ts', 'publicConfig.sentry.dsn');
  requireFileExcludes(errors, 'app/lib/telemetry.client.ts', 'ingest.us.sentry.io');
  requireFileExcludes(errors, 'app/lib/telemetry.client.ts', "dsn: 'https://");
  requireFileContains(
    errors,
    'eslint.config.mjs',
    'Read runtime values from Cloudflare Worker env bindings with getOptionalBinding(env, NAME)',
  );
  requireFileContains(errors, 'eslint.config.mjs', 'keep process.env limited to production deploy scripts');
  requireFileExcludes(errors, 'eslint.config.mjs', 'globalThis.process.env');
  for (const binding of optionalWorkerStringBindings) {
    requireFileContains(errors, 'types/cloudflare-env.d.ts', `${binding}?: string;`);
  }
  for (const binding of publicRuntimeBindings) {
    requireFileContains(errors, 'app/server-handlers/public-config.ts', `getOptionalBinding(env, '${binding}')`);
  }
  requireFileContains(errors, 'README.md', 'Optional runtime values such as Axiom');
  requireFileContains(errors, 'README.md', 'traces sampled at 5%');
  requireFileContains(errors, 'README.md', 'Agents emit structured diagnostics-channel events');
  requireFileContains(errors, 'DEVELOPMENT.md', 'Optional bindings include');
  requireFileContains(errors, 'DEVELOPMENT.md', 'traces at 5%');
  requireFileContains(errors, 'DEVELOPMENT.md', 'Agent-specific diagnostics are emitted');
  requireFileContains(
    errors,
    'ghostbuild-agent/prompts/secretsInstructions.ts',
    'Never write \\`.env\\`, \\`.env.*\\`',
  );
  requireFileContains(
    errors,
    'ghostbuild-agent/prompts/secretsInstructions.ts',
    '\\`.dev.vars\\`, or \\`.dev.vars.*\\`',
  );
  requireFileContains(errors, 'ghostbuild-agent/prompts/exampleDataInstructions.ts', 'TanStack Start app');
  requireFileContains(errors, 'ghostbuild-agent/prompts/exampleDataInstructions.ts', 'Cloudflare Worker code');
  requireFileContains(errors, 'ghostbuild-agent/prompts/exampleDataInstructions.ts', 'TanStack Start server function');
  requireFileContains(errors, 'ghostbuild-agent/prompts/solutionConstraints.ts', 'diagnostics-channel events');
  requireFileContains(errors, 'ghostbuild-agent/tools/lookupDocs.ts', 'diagnostics-channel events');
  requireFileContains(
    errors,
    'ghostbuild-agent/prompts/exampleDataInstructions.ts',
    '\\`src/server.ts\\` Worker API route',
  );
  requireFileContains(errors, 'ghostbuild-agent/prompts/workersAiGuidelines.ts', 'non-Cloudflare AI endpoints');
  requireFileExcludes(errors, 'ghostbuild-agent/prompts/exampleDataInstructions.ts', 'Vite app');
  requireFileExcludes(errors, 'ghostbuild-agent/prompts/exampleDataInstructions.ts', 'from an action');
  requireFileExcludes(errors, 'ghostbuild-agent/prompts/exampleDataInstructions.ts', 'in an action');
  requireFileExcludes(errors, 'ghostbuild-agent/prompts/workersAiGuidelines.ts', 'server actions');
  requireFileContains(errors, 'app/server-handlers/version.ts', "getOptionalBinding(env, 'WORKERS_CI_COMMIT_SHA')");
  requireFileExcludes(errors, 'app/components/VersionNotificationBanner.tsx', 'process.env');
  requireFileExcludes(errors, 'app/components/AppProviders.client.tsx', '/admin/');
  requireFileExcludes(errors, 'app/server.ts', 'upload_debug_prompt');
  requireFileExcludes(errors, 'app/server.ts', '__debug/download_messages');
  requireFileExcludes(errors, 'app/lib/cloudflare/data.server.ts', 'debugDownloadMessagesAction');
  requireFileExcludes(errors, 'app/lib/cloudflare/data.server.ts', 'debug_prompt_logs');
  requireFileExcludes(errors, 'vite.config.ts', 'process.env.WORKERS_CI_COMMIT_SHA');
  requireFileContains(errors, 'template/tsconfig.json', '"extends": "agents/tsconfig"');
  requireFileContains(errors, 'template/vite.config.ts', 'import agents from "agents/vite";');
  requireFileContains(errors, 'template/vite.config.ts', 'agents()');
  requireFileContains(errors, 'template/vite.config.ts', 'cloudflare({ viteEnvironment: { name: "ssr" } })');
  requireFileContains(errors, 'template/vite.config.ts', 'tanstackStart()');
  requireFileContains(errors, 'template/src/server.ts', 'import handler from "@tanstack/react-start/server-entry";');
  requireFileContains(errors, 'template/src/server.ts', 'import { routeAgentRequest } from "agents";');
  requireFileContains(errors, 'template/src/server.ts', 'export { AppAgent } from "./agents/app-agent";');
  requireFileContains(errors, 'template/src/server.ts', 'const agentResponse = await routeAgentRequest(request, env);');
  requireFileContains(errors, 'template/src/server.ts', 'return handler.fetch(request);');
  requireFileContainsInOrder(errors, 'template/src/server.ts', [
    'const agentResponse = await routeAgentRequest(request, env);',
    'if (url.pathname === "/api/decisions")',
    'return handler.fetch(request);',
  ]);
  requireFileExcludes(errors, 'template/src/server.ts', 'if (url.pathname === "/api/ai")');
  requireFileExcludes(errors, 'template/src/server.ts', 'handler.fetch(request, env');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'from "@cloudflare/ai-chat"');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'AIChatAgent,');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'export class AppAgent extends AIChatAgent<Env');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'static override options');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'sendIdentityOnConnect: false');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'override chatRecovery');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'override maxPersistedMessages = 200');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'override messageConcurrency = "queue" as const');
  requireFileContains(
    errors,
    'template/src/agents/app-agent.ts',
    'override waitForMcpConnections = { timeout: 10_000 }',
  );
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'terminalMessage:');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'override chatStreamStallTimeoutMs = 60_000');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'override async onChatRecovery');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'override async onChatMessage');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'options?: { abortSignal?: AbortSignal }');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'abortSignal: options?.abortSignal');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'createWorkersAI({ binding: this.env.AI })');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'pruneMessages,');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'convertToModelMessages(this.messages)');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'messages: pruneMessages({');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'reasoning: "before-last-message"');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'toolCalls: "before-last-message"');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', '@callable()');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'this.sql`');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'this.setState(');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'this.env.AI.run(WORKERS_AI_CODING_MODEL');
  requireFileContains(errors, 'template/src/agents/app-agent.ts', 'from "../workers-ai.shared"');
  requireFileExcludes(errors, 'template/src/agents/app-agent.ts', '"@cf/zai-org/glm-5.2"');
  requireFileContains(errors, 'template/src/workers-ai.shared.ts', '@cf/zai-org/glm-5.2');
  requireFileContains(errors, 'template/src/workers-ai.shared.ts', 'export const WORKERS_AI_CODING_MODEL =');
  requireFileContains(errors, 'template/src/db/app-db.ts', 'queryCollectionOptions<AppDecision>');
  requireFileContains(errors, 'template/src/db/app-db.ts', 'onInsert: async ({ transaction })');
  requireFileContains(errors, 'template/src/db/app-db.ts', 'transaction.mutations.map');
  requireFileContains(errors, 'template/src/db/app-db.ts', 'decisionsCollection.insert(decision');
  requireFileContains(errors, 'template/src/db/app-db.ts', 'await tx.isPersisted.promise');
  requireFileExcludes(errors, 'template/src/db/app-db.ts', 'utils.writeUpdate');
  requireFileExcludes(errors, 'template/src/db/app-db.ts', 'utils.writeDelete');
  requireFileContains(errors, 'template/src/routes/index.tsx', 'useLiveQuery(decisionsCollection)');
  requireFileContains(errors, 'template/src/routes/__root.tsx', 'QueryClientProvider');
  requireFileContains(errors, 'template/src/routes/index.tsx', 'useAgentChat({ agent: appAgent })');
  requireFileContains(
    errors,
    'template/src/routes/index.tsx',
    'const agentReady = !appAgent.connectionError && appAgent.state !== undefined;',
  );
  requireFileExcludes(errors, 'template/src/routes/index.tsx', 'appAgent.identified');
  requireFileContains(errors, 'template/src/routes/index.tsx', 'isRecovering,');
  requireFileContains(errors, 'template/src/routes/index.tsx', 'isRecovering || chatStatus ===');
  requireFileContains(errors, 'template/src/routes/index.tsx', 'stop,');
  requireFileContains(
    errors,
    'template/src/routes/index.tsx',
    'Durable Agent recovery is resuming the interrupted turn.',
  );
  requireFileContains(errors, 'template/src/routes/index.tsx', 'from "../workers-ai.shared"');
  requireFileExcludes(errors, 'template/src/routes/index.tsx', 'from "../workers-ai"');
  requireFileExcludes(errors, 'template/src/routes/index.tsx', 'fetch("/api/ai"');
  requireFileContains(errors, 'template/src/server.ts', 'import { z } from "zod";');
  requireFileContains(errors, 'template/src/server.ts', 'const decisionRequestSchema = z.object');
  requireFileContains(errors, 'template/src/server.ts', 'createdAt: z.number().finite().optional()');
  requireFileExcludes(errors, 'template/src/db/app-db.ts', 'utils.writeInsert');
  for (const expected of templateRequiredMigrationSnippets) {
    requireFileContains(errors, 'template/migrations/0001_app_data.sql', expected);
  }
  requireFileContains(
    errors,
    'template/scripts/verify-production-config.mjs',
    'const allowUnprovisioned = process.argv.includes("--allow-unprovisioned");',
  );
  requireFileContains(
    errors,
    'template/scripts/verify-production-config.mjs',
    'findMissingProvisionScriptPatternErrors',
  );
  requireFileContains(errors, 'template/scripts/verify-production-config.mjs', 'verifyProvisionScript();');
  requireFileExcludes(errors, 'template/scripts/verify-production-config.mjs', 'CLOUDFLARE_API_TOKEN');
  requireFileExcludes(errors, 'template/scripts/verify-production-config.mjs', 'CLOUDFLARE_ACCOUNT_ID');
  requireFileContains(errors, 'template/scripts/verify-stack-alignment.mjs', 'const requiredPackages = [');
  requireFileContains(errors, 'template/scripts/verify-stack-alignment.mjs', 'forbiddenRuntimeEnvAccessPatterns');
  requireFileContains(
    errors,
    'template/scripts/verify-stack-alignment.mjs',
    'must read runtime config from Cloudflare Worker bindings',
  );
  requireFileContains(errors, 'template/scripts/verify-stack-alignment.mjs', 'findCloudflareAiPeerCompatibilityErrors');
  requireFileExcludes(errors, 'app/components/chat/MessageInput.tsx', 'ModelSelector');
  requireFileExcludes(errors, 'app/components/chat/Chat.tsx', "from '~/lib/workers-ai-model'");
  requireFileExcludes(errors, 'app/components/chat/Chat.tsx', 'modelChoice');
  requireFileExcludes(errors, 'app/components/chat/Chat.tsx', 'useLocalStorage<ModelSelection>');
  requireFileExcludes(errors, 'app/components/chat/Chat.tsx', 'modelSelection={');
  requireFileExcludes(errors, 'app/components/chat/BaseChat.client.tsx', 'setModelSelection');
  requireFileExcludes(errors, 'app/components/chat/MessageInput.tsx', 'setModelSelection');
  requireFileContains(errors, 'app/components/chat/MessageInput.tsx', 'CLOUDFLARE_WORKERS_AI_MODEL');
  requireFileExcludes(errors, 'app/utils/constants.ts', 'ModelSelection');
  requireFileExcludes(errors, 'app/components/chat/Chat.tsx', "case 'auto'");
  requireFileContains(errors, 'template/eslint.config.js', 'typescript-eslint');
  requireFileContains(errors, 'template/eslint.config.js', 'eslint-plugin-react-hooks');
  requireFileContains(errors, 'template/eslint.config.js', 'globals.serviceworker');
  requireFileContains(errors, 'app/styles/variables.css', '--gb-content-primary');
  requireFileExcludes(errors, 'app/styles/variables.css', '--cvx-');
  requireExactFileContent(errors, '.nvmrc', requiredNodeVersion);
  requireFileContains(errors, '.github/actions/setup-and-build/action.yaml', `default: '${requiredNodeVersion}'`);
  requireFileContains(errors, '.github/actions/setup-and-build/action.yaml', `default: '${requiredPnpmVersion}'`);

  return errors;
}

export function main() {
  const errors = verifyStackAlignment();
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
