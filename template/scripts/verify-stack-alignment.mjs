import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const requiredPackages = [
  "@ai-sdk/provider",
  "@ai-sdk/react",
  "@cloudflare/ai-chat",
  "@cloudflare/vite-plugin",
  "@tanstack/db",
  "@tanstack/query-db-collection",
  "@tanstack/react-db",
  "@tanstack/react-query",
  "@tanstack/react-router",
  "@tanstack/react-start",
  "@tanstack/router-cli",
  "@vitejs/plugin-react",
  "agents",
  "ai",
  "react",
  "react-dom",
  "typescript",
  "vite",
  "workers-ai-provider",
  "wrangler",
  "zod",
];
const cloudflareAiPeerPackages = [
  "agents",
  "@cloudflare/ai-chat",
  "workers-ai-provider",
];
const cloudflareAiPeerRequirements = [
  {
    packageName: "ai",
    expectedPrefix: "^6.",
    peerRange: "^6.0.0",
  },
  {
    packageName: "@ai-sdk/react",
    expectedPrefix: "^3.",
    peerRange: "^3.0.204",
  },
  {
    packageName: "@ai-sdk/provider",
    expectedPrefix: "^3.",
    peerRange: "^3.0.0",
  },
];
const forbiddenLockfiles = ["package-lock.json"];
const requiredNodeEngine = ">=26.0.0";
const requiredPnpmVersion = "9.5.0";
const requiredMigrationSnippets = [
  "CREATE TABLE IF NOT EXISTS decisions",
  "INSERT OR IGNORE INTO decisions",
  "TanStack Start, TanStack DB, TanStack Query, Cloudflare Workers, D1, R2, Workers AI, and Agents.",
];
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
const forbiddenRuntimeEnvAccessPatterns = [
  /\bprocess\.env\b/,
  /\bimport\.meta\.env\b/,
];
const sourceExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);

function readJson(path) {
  return JSON.parse(readFileSync(resolve(rootDir, path), "utf8"));
}

function dependencyNames(pkg) {
  return new Set(
    dependencySections.flatMap((section) => {
      const values = pkg?.[section];
      return values && typeof values === "object" ? Object.keys(values) : [];
    }),
  );
}

function packageDependencyVersion(pkg, name) {
  for (const section of dependencySections) {
    const version = pkg?.[section]?.[name];
    if (typeof version === "string") {
      return version;
    }
  }
  return undefined;
}

function findCloudflareAiPeerCompatibilityErrors(pkg, label) {
  const installedCloudflarePeerPackages = cloudflareAiPeerPackages.filter(
    (name) => packageDependencyVersion(pkg, name),
  );
  if (installedCloudflarePeerPackages.length === 0) {
    return [];
  }

  return cloudflareAiPeerRequirements.flatMap(
    ({ packageName, expectedPrefix, peerRange }) => {
      const version = packageDependencyVersion(pkg, packageName);
      if (!version || version.startsWith(expectedPrefix)) {
        return [];
      }

      return [
        `${label} must keep ${packageName} on ${expectedPrefix}x while ${installedCloudflarePeerPackages.join(
          ", ",
        )} require ${packageName} ${peerRange}; found ${version}.`,
      ];
    },
  );
}

function collectSourceFiles(directory) {
  const files = [];

  function visit(path) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path)) {
        if (
          child === "node_modules" ||
          child === "dist" ||
          child === ".wrangler"
        ) {
          continue;
        }
        visit(join(path, child));
      }
      return;
    }

    if (sourceExtensions.has(extname(path))) {
      files.push(path);
    }
  }

  visit(resolve(rootDir, directory));
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
  const content = readFileSync(resolve(rootDir, path), "utf8");
  if (!content.includes(expected)) {
    errors.push(`${path} must contain ${expected}.`);
  }
}

function requireFileExcludes(errors, path, forbidden) {
  const content = readFileSync(resolve(rootDir, path), "utf8");
  if (content.includes(forbidden)) {
    errors.push(`${path} must not contain ${forbidden}.`);
  }
}

function verifyStackAlignment() {
  const errors = [];
  const packageJson = readJson("package.json");
  const names = dependencyNames(packageJson);

  for (const name of names) {
    if (forbiddenDependencyPatterns.some((pattern) => pattern.test(name))) {
      errors.push(
        `package.json must not depend on ${name}; use Workers AI and TanStack/Cloudflare APIs.`,
      );
    }
  }

  for (const name of requiredPackages) {
    if (!names.has(name)) {
      errors.push(
        `package.json must include ${name} for the TanStack Start + Cloudflare stack.`,
      );
    }
  }

  errors.push(
    ...findCloudflareAiPeerCompatibilityErrors(packageJson, "package.json"),
  );

  if (packageJson.engines?.node !== requiredNodeEngine) {
    errors.push(`package.json must set engines.node to ${requiredNodeEngine}.`);
  }

  if (packageJson.packageManager !== `pnpm@${requiredPnpmVersion}`) {
    errors.push(
      `package.json must pin packageManager to pnpm@${requiredPnpmVersion}.`,
    );
  }

  if (!packageJson.devDependencies?.["@types/node"]?.startsWith("^26.")) {
    errors.push(
      "package.json must use @types/node ^26.x for the Node 26 toolchain.",
    );
  }

  for (const path of forbiddenLockfiles) {
    if (existsSync(resolve(rootDir, path))) {
      errors.push(
        `${path} must not exist; generated apps use pnpm lockfiles only.`,
      );
    }
  }

  for (const file of collectSourceEntries([
    "src",
    "scripts",
    "vite.config.ts",
  ])) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (forbiddenImportPatterns.some((pattern) => pattern.test(line))) {
        errors.push(
          `${file}:${index + 1} imports a forbidden provider/framework module.`,
        );
      }
    });
  }

  for (const file of collectSourceEntries(["src", "vite.config.ts"])) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (
        forbiddenRuntimeEnvAccessPatterns.some((pattern) => pattern.test(line))
      ) {
        errors.push(
          `${file}:${index + 1} must read runtime config from Cloudflare Worker bindings, not process.env or import.meta.env.`,
        );
      }
    });
  }

  const workersAiHelper = readFileSync(
    resolve(rootDir, "src/workers-ai.shared.ts"),
    "utf8",
  );
  if (!workersAiHelper.includes("@cf/zai-org/glm-5.2")) {
    errors.push("src/workers-ai.shared.ts must use @cf/zai-org/glm-5.2.");
  }

  requireFileContains(errors, "tsconfig.json", '"extends": "agents/tsconfig"');
  requireFileContains(
    errors,
    "vite.config.ts",
    'import agents from "agents/vite";',
  );
  requireFileContains(errors, "vite.config.ts", "agents()");
  requireFileContains(
    errors,
    "vite.config.ts",
    'cloudflare({ viteEnvironment: { name: "ssr" } })',
  );
  requireFileContains(errors, "vite.config.ts", "tanstackStart()");
  requireFileContains(
    errors,
    "src/server.ts",
    'import handler from "@tanstack/react-start/server-entry";',
  );
  requireFileContains(
    errors,
    "src/server.ts",
    'import { routeAgentRequest } from "agents";',
  );
  requireFileContains(
    errors,
    "src/server.ts",
    'export { AppAgent } from "./agents/app-agent";',
  );
  requireFileContains(
    errors,
    "src/server.ts",
    "const agentResponse = await routeAgentRequest(request, env);",
  );
  requireFileContains(
    errors,
    "src/server.ts",
    "return handler.fetch(request);",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    'from "@cloudflare/ai-chat"',
  );
  requireFileContains(errors, "src/agents/app-agent.ts", "AIChatAgent,");
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "export class AppAgent extends AIChatAgent<Env",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "static override options",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "sendIdentityOnConnect: false",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "override chatRecovery",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "override maxPersistedMessages = 200",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    'override messageConcurrency = "queue" as const',
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "override waitForMcpConnections = { timeout: 10_000 }",
  );
  requireFileContains(errors, "src/agents/app-agent.ts", "terminalMessage:");
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "override chatStreamStallTimeoutMs = 60_000",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "override async onChatRecovery",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "override async onChatMessage",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "options?: { abortSignal?: AbortSignal }",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "abortSignal: options?.abortSignal",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "createWorkersAI({ binding: this.env.AI })",
  );
  requireFileContains(errors, "src/agents/app-agent.ts", "pruneMessages,");
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "convertToModelMessages(this.messages)",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "messages: pruneMessages({",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    'reasoning: "before-last-message"',
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    'toolCalls: "before-last-message"',
  );
  requireFileContains(errors, "src/agents/app-agent.ts", "@callable()");
  requireFileContains(errors, "src/agents/app-agent.ts", "this.sql`");
  requireFileContains(errors, "src/agents/app-agent.ts", "this.setState(");
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    "this.env.AI.run(WORKERS_AI_CODING_MODEL",
  );
  requireFileContains(
    errors,
    "src/agents/app-agent.ts",
    'from "../workers-ai.shared"',
  );
  requireFileExcludes(
    errors,
    "src/agents/app-agent.ts",
    '"@cf/zai-org/glm-5.2"',
  );
  requireFileContains(
    errors,
    "src/workers-ai.shared.ts",
    "export const WORKERS_AI_CODING_MODEL =",
  );
  requireFileContains(
    errors,
    "src/db/app-db.ts",
    "queryCollectionOptions<AppDecision>",
  );
  requireFileContains(
    errors,
    "src/db/app-db.ts",
    "onInsert: async ({ transaction })",
  );
  requireFileContains(errors, "src/db/app-db.ts", "transaction.mutations.map");
  requireFileContains(
    errors,
    "src/db/app-db.ts",
    "decisionsCollection.insert(decision",
  );
  requireFileContains(
    errors,
    "src/db/app-db.ts",
    "await tx.isPersisted.promise",
  );
  requireFileExcludes(errors, "src/db/app-db.ts", "utils.writeInsert");
  requireFileExcludes(errors, "src/db/app-db.ts", "utils.writeUpdate");
  requireFileExcludes(errors, "src/db/app-db.ts", "utils.writeDelete");
  requireFileContains(
    errors,
    "src/routes/index.tsx",
    "useLiveQuery(decisionsCollection)",
  );
  requireFileContains(errors, "src/routes/__root.tsx", "QueryClientProvider");
  requireFileContains(
    errors,
    "src/routes/index.tsx",
    "useAgentChat({ agent: appAgent })",
  );
  requireFileContains(
    errors,
    "src/routes/index.tsx",
    "const agentReady = !appAgent.connectionError && appAgent.state !== undefined;",
  );
  requireFileExcludes(errors, "src/routes/index.tsx", "appAgent.identified");
  requireFileContains(errors, "src/routes/index.tsx", "isRecovering,");
  requireFileContains(
    errors,
    "src/routes/index.tsx",
    "isRecovering || chatStatus ===",
  );
  requireFileContains(errors, "src/routes/index.tsx", "stop,");
  requireFileContains(
    errors,
    "src/routes/index.tsx",
    "Durable Agent recovery is resuming the interrupted turn.",
  );
  requireFileContains(
    errors,
    "src/routes/index.tsx",
    'from "../workers-ai.shared"',
  );
  requireFileExcludes(errors, "src/routes/index.tsx", 'from "../workers-ai"');
  requireFileExcludes(errors, "src/routes/index.tsx", 'fetch("/api/ai"');
  requireFileContains(errors, "src/server.ts", 'import { z } from "zod";');
  requireFileContains(
    errors,
    "src/server.ts",
    "const decisionRequestSchema = z.object",
  );
  requireFileContains(
    errors,
    "src/server.ts",
    "createdAt: z.number().finite().optional()",
  );
  requireFileExcludes(
    errors,
    "src/server.ts",
    'if (url.pathname === "/api/ai")',
  );
  requireFileExcludes(errors, "src/server.ts", "handler.fetch(request, env");
  for (const expected of requiredMigrationSnippets) {
    requireFileContains(errors, "migrations/0001_app_data.sql", expected);
  }
  requireFileContains(errors, ".gitignore", ".env*");
  requireFileContains(errors, ".gitignore", ".envrc");
  requireFileContains(errors, ".gitignore", ".dev.vars*");

  if (!existsSync(resolve(rootDir, "eslint.config.js"))) {
    errors.push(
      "eslint.config.js must exist for generated-app source linting.",
    );
    return errors;
  }

  const eslintConfig = readFileSync(
    resolve(rootDir, "eslint.config.js"),
    "utf8",
  );
  for (const expected of [
    "typescript-eslint",
    "eslint-plugin-react-hooks",
    "eslint-plugin-react-refresh",
    "globals.serviceworker",
  ]) {
    if (!eslintConfig.includes(expected)) {
      errors.push(`eslint.config.js must contain ${expected}.`);
    }
  }

  return errors;
}

function main() {
  const errors = verifyStackAlignment();
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
