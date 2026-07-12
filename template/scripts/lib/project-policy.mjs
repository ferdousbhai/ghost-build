import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
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
  /^@google\/(?:genai|generative-ai)$/,
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
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"]@google\/(?:genai|generative-ai)['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"]@ai-sdk\/(?!provider(?:\/|['"])|react(?:\/|['"]))[^'"]*['"]/,
  /(?:from\s+|import\s+(?:[^'"]+\s+from\s+)?)['"](?:groq-sdk|@mistralai\/mistralai)['"]/,
];

const sourceExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  ".wrangler",
  "dist",
  "fixtures",
  "node_modules",
]);

export const REQUIRED_NODE_ENGINE = ">=26.0.0";
export const REQUIRED_NODE_TYPES_MAJOR = "^26.";
export const REQUIRED_PNPM_VERSION = "9.5.0";

export const APP_REQUIRED_PACKAGES = [
  "@ai-sdk/provider",
  "@ai-sdk/react",
  "@cloudflare/ai-chat",
  "@cloudflare/vite-plugin",
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

export const APPROVED_BUILD_DEPENDENCIES = [
  "core-js-pure",
  "esbuild",
  "sharp",
  "workerd",
];

export function findBuildApprovalErrors(workspace, label) {
  return APPROVED_BUILD_DEPENDENCIES.flatMap((dependency) => {
    const errors = [];
    if (!new RegExp(`^\\s*- ${dependency}$`, "m").test(workspace)) {
      errors.push(`${label} onlyBuiltDependencies must include ${dependency}.`);
    }
    if (!new RegExp(`^\\s*${dependency}: true$`, "m").test(workspace)) {
      errors.push(`${label} allowBuilds must approve ${dependency}.`);
    }
    return errors;
  });
}

export function dependencyNames(pkg) {
  return new Set(
    dependencySections.flatMap((section) => {
      const values = pkg?.[section];
      return values && typeof values === "object" ? Object.keys(values) : [];
    }),
  );
}

export function packageDependencyVersion(pkg, name) {
  for (const section of dependencySections) {
    const version = pkg?.[section]?.[name];
    if (typeof version === "string") {
      return version;
    }
  }
  return undefined;
}

export function findForbiddenDependencies(pkg, label) {
  return [...dependencyNames(pkg)]
    .filter((name) =>
      forbiddenDependencyPatterns.some((pattern) => pattern.test(name)),
    )
    .map(
      (name) =>
        `${label} must not depend on ${name}; use Cloudflare Workers AI and TanStack/Cloudflare APIs.`,
    );
}

export function findMissingDependencies(pkg, label, requiredPackages) {
  const names = dependencyNames(pkg);
  return requiredPackages
    .filter((name) => !names.has(name))
    .map(
      (name) =>
        `${label} must include ${name} for the TanStack Start + Cloudflare stack.`,
    );
}

export function findPackageVersionAlignmentErrors(
  referencePkg,
  pkg,
  label,
  packageNames,
) {
  return packageNames.flatMap((name) => {
    const expected = packageDependencyVersion(referencePkg, name);
    const actual = packageDependencyVersion(pkg, name);
    return expected && actual && actual !== expected
      ? [
          `${label} must align ${name} with package.json ${expected}; found ${actual}.`,
        ]
      : [];
  });
}

export function findCloudflareAiPeerCompatibilityErrors(pkg, label) {
  const peers = ["agents", "@cloudflare/ai-chat", "workers-ai-provider"].filter(
    (name) => packageDependencyVersion(pkg, name),
  );
  if (peers.length === 0) {
    return [];
  }

  return [
    ["ai", "^6.", "^6.0.0"],
    ["@ai-sdk/react", "^3.", "^3.0.204"],
    ["@ai-sdk/provider", "^3.", "^3.0.0"],
  ].flatMap(([name, prefix, peerRange]) => {
    const version = packageDependencyVersion(pkg, name);
    return version && !version.startsWith(prefix)
      ? [
          `${label} must keep ${name} on ${prefix}x while ${peers.join(
            ", ",
          )} require ${name} ${peerRange}; found ${version}.`,
        ]
      : [];
  });
}

export function findRuntimePinErrors(pkg, label) {
  const errors = [];
  if (pkg?.engines?.node !== REQUIRED_NODE_ENGINE) {
    errors.push(`${label} must set engines.node to ${REQUIRED_NODE_ENGINE}.`);
  }
  if (pkg?.packageManager !== `pnpm@${REQUIRED_PNPM_VERSION}`) {
    errors.push(
      `${label} must pin packageManager to pnpm@${REQUIRED_PNPM_VERSION}.`,
    );
  }
  if (
    !pkg?.devDependencies?.["@types/node"]?.startsWith(
      REQUIRED_NODE_TYPES_MAJOR,
    )
  ) {
    errors.push(
      `${label} must use @types/node ^26.x for the Node 26 toolchain.`,
    );
  }
  return errors;
}

export function collectSourceEntries(rootDir, entries) {
  const files = [];

  function visit(path) {
    if (!existsSync(path)) {
      return;
    }
    const name = path.split(/[\\/]/).pop();
    if (name && ignoredDirectories.has(name)) {
      return;
    }
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path)) {
        visit(join(path, child));
      }
    } else if (sourceExtensions.has(extname(path))) {
      files.push(path);
    }
  }

  for (const entry of entries) {
    visit(resolve(rootDir, entry));
  }
  return files;
}

export function findForbiddenImports(files) {
  return findLineViolations(
    files,
    (line) => forbiddenImportPatterns.some((pattern) => pattern.test(line)),
    "imports a forbidden provider/framework module.",
  );
}

export function findForbiddenRuntimeEnvAccess(files, allowlist = []) {
  const patterns = [/\bprocess\.env\b/, /\bimport\.meta\.env\b/];
  const errors = [];
  for (const file of files) {
    const normalizedFile = file.replaceAll("\\", "/");
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (!patterns.some((pattern) => pattern.test(line))) {
          return;
        }
        const allowed = allowlist.some(
          ({ pathSuffix, snippet }) =>
            normalizedFile.endsWith(pathSuffix) && line.includes(snippet),
        );
        if (!allowed) {
          errors.push(
            `${file}:${index + 1} must read runtime config from Cloudflare Worker bindings, not process.env or import.meta.env.`,
          );
        }
      });
  }
  return errors;
}

function findLineViolations(files, predicate, message) {
  const errors = [];
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (predicate(line)) {
          errors.push(`${file}:${index + 1} ${message}`);
        }
      });
  }
  return errors;
}

export function findMissingCommandSteps(command, label, steps) {
  if (typeof command !== "string") {
    return [`${label} must be configured.`];
  }
  const errors = [];
  let cursor = -1;
  for (const step of steps) {
    const index = command.indexOf(step, cursor + 1);
    if (index === -1) {
      errors.push(`${label} must run ${JSON.stringify(step)} in order.`);
    } else {
      cursor = index;
    }
  }
  return errors;
}

export function findMissingPaths(rootDir, paths) {
  return paths
    .filter((path) => !existsSync(resolve(rootDir, path)))
    .map((path) => `${path} must exist.`);
}

export function findForbiddenPaths(rootDir, paths, reason) {
  return paths
    .filter((path) => existsSync(resolve(rootDir, path)))
    .map((path) => `${path} must not exist; ${reason}.`);
}

export function findWorkerRuntimeSecretErrors(config, label, guidance) {
  return config?.secrets
    ? [`${label} must not declare Worker runtime secrets; ${guidance}.`]
    : [];
}

export function findWorkerObservabilityErrors(
  config,
  label,
  { logsSamplingRate = 0.6, tracesSamplingRate = 0.05 } = {},
) {
  const observability = config?.observability;
  return [
    ["observability.enabled", observability?.enabled, true],
    ["observability.logs.enabled", observability?.logs?.enabled, true],
    [
      "observability.logs.head_sampling_rate",
      observability?.logs?.head_sampling_rate,
      logsSamplingRate,
    ],
    ["observability.traces.enabled", observability?.traces?.enabled, true],
    [
      "observability.traces.head_sampling_rate",
      observability?.traces?.head_sampling_rate,
      tracesSamplingRate,
    ],
  ]
    .filter(([, actual, expected]) => actual !== expected)
    .map(
      ([path, actual, expected]) =>
        `${label} ${path} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`,
    );
}

export function findMissingWorkflowTextErrors(content, label, requiredText) {
  return requiredText
    .filter((expected) => !content.includes(expected))
    .map((expected) => `${label} must contain ${JSON.stringify(expected)}.`);
}

export function findWorkflowSequenceErrors(content, label, requiredSequence) {
  const errors = [];
  let cursor = -1;
  for (const expected of requiredSequence) {
    const index = content.indexOf(expected, cursor + 1);
    if (index === -1) {
      errors.push(
        `${label} must run ${JSON.stringify(expected)} in the production deploy sequence.`,
      );
    } else {
      cursor = index;
    }
  }
  return errors;
}

const stagingPattern = /\bstaging\b/i;
const localEnvPattern =
  /(?:^|\s)--env-file(?:[=\s]|$)|(?:^|[\s"'`])(?:\.env(?:\.[\w.-]+)?|\.dev\.vars(?:\.[\w.-]+)?)(?=$|[\s"'`])/;
const forbiddenWorkflowPatterns = [
  { pattern: stagingPattern, reason: "target staging" },
  { pattern: /\bwrangler\s+dev\b/, reason: "start Wrangler dev" },
  { pattern: /\bvite\s+(?:--host|dev)\b/, reason: "start Vite dev" },
  {
    pattern: /\b(?:pnpm|npm)\s+(?:run\s+)?(?:dev|start|preview)\b/,
    reason: "start a local package script",
  },
  { pattern: localEnvPattern, reason: "load local env files" },
];

export function findForbiddenWorkflowCommandErrors(content, label) {
  const errors = [];
  content.split("\n").forEach((line, index) => {
    for (const { pattern, reason } of forbiddenWorkflowPatterns) {
      if (pattern.test(line)) {
        errors.push(`${label}:${index + 1} must not ${reason}.`);
      }
    }
  });
  return errors;
}

export function findMissingProvisionScriptPatternErrors(
  content,
  label,
  requiredPatterns,
) {
  return requiredPatterns
    .filter(({ pattern }) => !pattern.test(content))
    .map(({ description }) => `${label} must ${description}.`);
}

export function workflowPathsFromDirectoryEntries(entries) {
  return entries
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .map((entry) => `.github/workflows/${entry}`)
    .sort();
}

export function startsLocalDevServer(content) {
  return /\bwrangler\s+dev\b|\bvite\s+(?:--host|dev)\b/.test(content);
}

export function targetsStaging(...values) {
  return values.some((value) => stagingPattern.test(value));
}

export function loadsLocalEnvFiles(content) {
  return localEnvPattern.test(content);
}
