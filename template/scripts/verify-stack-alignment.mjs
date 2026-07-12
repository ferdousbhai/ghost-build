import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import {
  APP_REQUIRED_PACKAGES,
  collectSourceEntries,
  findCloudflareAiPeerCompatibilityErrors,
  findForbiddenDependencies,
  findForbiddenImports,
  findForbiddenRuntimeEnvAccess,
  findBuildApprovalErrors,
  findMissingCommandSteps,
  findMissingDependencies,
  findMissingPaths,
  findRuntimePinErrors,
} from "./lib/project-policy.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredPaths = [
  "eslint.config.js",
  "migrations",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "src/agents/app-agent.ts",
  "src/routeTree.gen.ts",
  "src/router.tsx",
  "src/routes/__root.tsx",
  "src/routes/index.tsx",
  "src/server.ts",
  "tsconfig.json",
  "vite.config.ts",
  "worker-configuration.d.ts",
  "wrangler.jsonc",
];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(rootDir, path), "utf8"));
}

export function verifyStackAlignment() {
  const errors = [];
  const packageJson = readJson("package.json");
  errors.push(
    ...findForbiddenDependencies(packageJson, "package.json"),
    ...findMissingDependencies(
      packageJson,
      "package.json",
      APP_REQUIRED_PACKAGES,
    ),
    ...findCloudflareAiPeerCompatibilityErrors(packageJson, "package.json"),
    ...findRuntimePinErrors(packageJson, "package.json"),
    ...findMissingPaths(rootDir, requiredPaths),
  );

  if (existsSync(resolve(rootDir, "package-lock.json"))) {
    errors.push("package-lock.json must not exist; generated apps use pnpm.");
  }
  const workspace = readFileSync(
    resolve(rootDir, "pnpm-workspace.yaml"),
    "utf8",
  );
  errors.push(...findBuildApprovalErrors(workspace, "pnpm-workspace.yaml"));

  const scripts = packageJson.scripts ?? {};
  if (scripts.dev !== "vite dev --host 0.0.0.0") {
    errors.push(
      'package.json must define "dev": "vite dev --host 0.0.0.0" for WebContainer preview.',
    );
  }
  if (scripts.preview !== "vite preview --host 0.0.0.0") {
    errors.push(
      'package.json must define "preview": "vite preview --host 0.0.0.0".',
    );
  }
  errors.push(
    ...findMissingCommandSteps(
      scripts.typecheck,
      "package.json scripts.typecheck",
      ["generate-routes", "cf-typegen", "tsc"],
    ),
    ...findMissingCommandSteps(scripts.deploy, "package.json scripts.deploy", [
      "verify:stack",
      "typecheck",
      "provision:production",
      "verify:production-config",
      "build",
      "lint",
      "d1:migrations:apply:production",
      "wrangler deploy",
    ]),
  );

  const tsconfig = parse(
    readFileSync(resolve(rootDir, "tsconfig.json"), "utf8"),
  );
  if (tsconfig?.extends !== "agents/tsconfig") {
    errors.push('tsconfig.json must extend "agents/tsconfig".');
  }
  if (tsconfig?.compilerOptions?.noUnusedLocals === false) {
    errors.push("tsconfig.json must not disable noUnusedLocals.");
  }
  if (tsconfig?.compilerOptions?.noUnusedParameters === false) {
    errors.push("tsconfig.json must not disable noUnusedParameters.");
  }

  const files = collectSourceEntries(rootDir, ["src", "vite.config.ts"]);
  errors.push(
    ...findForbiddenImports(files),
    ...findForbiddenRuntimeEnvAccess(files, [
      {
        pathSuffix: "vite.config.ts",
        snippet: "process.env.GHOSTBUILD_PREVIEW",
      },
    ]),
  );
  return errors;
}

export function main() {
  const errors = verifyStackAlignment();
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
