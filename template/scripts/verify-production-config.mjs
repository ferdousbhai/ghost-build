import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const allowUnprovisioned = process.argv.includes("--allow-unprovisioned");
const REQUIRED_COMPATIBILITY_DATE = "2026-06-30";
const PLACEHOLDER_D1_ID = "00000000-0000-0000-0000-000000000000";
const REQUIRED_LOGS_SAMPLING_RATE = 0.6;
const REQUIRED_TRACES_SAMPLING_RATE = 0.05;
const FORBIDDEN_PRODUCTION_SCRIPT_NAMES = new Set([
  "dev",
  "start",
  "preview",
  "deploy:local",
  "deploy:staging",
  "dev:local",
  "start:local",
  "start:staging",
]);
const STAGING_PATTERN = /\bstaging\b/i;
const LOCAL_ENV_FILE_PATTERN =
  /(?:^|\s)--env-file(?:[=\s]|$)|(?:^|[\s"'`])(?:\.env(?:\.[\w.-]+)?|\.dev\.vars(?:\.[\w.-]+)?)(?=$|[\s"'`])/;
const LOCAL_DEV_SERVER_COMMAND_PATTERNS = [
  /\bwrangler\s+dev\b/,
  /\bvite\s+(?:--host|dev)\b/,
];
const REQUIRED_PROVISION_SCRIPT_PATTERNS = [
  {
    pattern: /\[["']d1["'],\s*["']list["'],\s*["']--json["']\]/s,
    description: "list Cloudflare D1 databases",
  },
  {
    pattern: /\[["']d1["'],\s*["']create["'],\s*databaseName\]/s,
    description: "create the production D1 database when missing",
  },
  {
    pattern: /\[["']d1_databases["'],\s*d1Index,\s*["']database_id["']/s,
    description: "write the non-secret D1 database_id into wrangler.jsonc",
  },
  {
    pattern: /\[["']r2["'],\s*["']bucket["'],\s*["']list["']\]/s,
    description: "list Cloudflare R2 buckets",
  },
  {
    pattern:
      /\[["']r2["'],\s*["']bucket["'],\s*["']create["'],\s*bucketName\]/s,
    description: "create the production R2 bucket when missing",
  },
];

function readJsoncConfig(path, label) {
  const raw = readFileSync(resolve(rootDir, path), "utf8");
  const parseErrors = [];
  const config = parse(raw, parseErrors, { allowTrailingComma: true });

  for (const error of parseErrors) {
    errors.push(
      `${label} has invalid JSONC: ${printParseErrorCode(error.error)} at offset ${error.offset}.`,
    );
  }

  return config;
}

function readJsonConfig(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(rootDir, path), "utf8"));
  } catch (error) {
    errors.push(
      `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return undefined;
  }
}

function readTextConfig(path, label) {
  try {
    return readFileSync(resolve(rootDir, path), "utf8");
  } catch (error) {
    errors.push(
      `${label} must exist: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return undefined;
  }
}

function requireEqual(label, actual, expected) {
  if (actual !== expected) {
    errors.push(
      `${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`,
    );
  }
}

function requireArrayIncludes(label, values, expected) {
  if (!Array.isArray(values) || !values.includes(expected)) {
    errors.push(`${label} must include ${JSON.stringify(expected)}.`);
  }
}

function findBinding(collection, binding) {
  return Array.isArray(collection)
    ? collection.find((item) => item?.binding === binding)
    : undefined;
}

function requireBinding(collection, binding, missingMessage) {
  const bindingConfig = findBinding(collection, binding);
  if (!bindingConfig) {
    errors.push(missingMessage);
  }
  return bindingConfig;
}

function findMissingProvisionScriptPatternErrors(content, label) {
  return REQUIRED_PROVISION_SCRIPT_PATTERNS.filter(
    ({ pattern }) => !pattern.test(content),
  ).map(({ description }) => `${label} must ${description}.`);
}

function startsLocalDevServer(content) {
  return LOCAL_DEV_SERVER_COMMAND_PATTERNS.some((pattern) =>
    pattern.test(content),
  );
}

function targetsStaging(...values) {
  return values.some((value) => STAGING_PATTERN.test(value));
}

function loadsLocalEnvFiles(content) {
  return LOCAL_ENV_FILE_PATTERN.test(content);
}

function findWorkerObservabilityErrors(config, label) {
  const observability = config?.observability;
  const requirements = [
    ["observability.enabled", observability?.enabled, true],
    ["observability.logs.enabled", observability?.logs?.enabled, true],
    [
      "observability.logs.head_sampling_rate",
      observability?.logs?.head_sampling_rate,
      REQUIRED_LOGS_SAMPLING_RATE,
    ],
    ["observability.traces.enabled", observability?.traces?.enabled, true],
    [
      "observability.traces.head_sampling_rate",
      observability?.traces?.head_sampling_rate,
      REQUIRED_TRACES_SAMPLING_RATE,
    ],
  ];

  return requirements
    .filter(([, actual, expected]) => actual !== expected)
    .map(
      ([path, actual, expected]) =>
        `${label} ${path} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`,
    );
}

function verifyWorkerConfig(config) {
  requireEqual("wrangler.jsonc main", config?.main, "src/server.ts");
  requireEqual(
    "wrangler.jsonc compatibility_date",
    config?.compatibility_date,
    REQUIRED_COMPATIBILITY_DATE,
  );
  requireArrayIncludes(
    "wrangler.jsonc compatibility_flags",
    config?.compatibility_flags,
    "nodejs_compat",
  );
  errors.push(...findWorkerObservabilityErrors(config, "wrangler.jsonc"));
  requireEqual(
    "wrangler.jsonc upload_source_maps",
    config?.upload_source_maps,
    true,
  );
  requireEqual("wrangler.jsonc ai.binding", config?.ai?.binding, "AI");

  if (config?.secrets) {
    errors.push(
      "wrangler.jsonc must not declare Worker runtime secrets; configure runtime values as Cloudflare bindings.",
    );
  }

  const d1 = requireBinding(
    config?.d1_databases,
    "DB",
    "wrangler.jsonc must bind D1 as DB.",
  );
  if (d1) {
    if (!d1.database_name) {
      errors.push("wrangler.jsonc D1 database_name must be configured.");
    }
    requireEqual(
      "wrangler.jsonc D1 migrations_dir",
      d1.migrations_dir,
      "migrations",
    );
    if (
      !allowUnprovisioned &&
      (!d1.database_id || d1.database_id === PLACEHOLDER_D1_ID)
    ) {
      errors.push(
        "Replace the placeholder D1 database_id in wrangler.jsonc before production deploy.",
      );
    }
  }

  const r2 = requireBinding(
    config?.r2_buckets,
    "APP_STORAGE",
    "wrangler.jsonc must bind R2 as APP_STORAGE.",
  );
  if (r2 && !r2.bucket_name) {
    errors.push("wrangler.jsonc R2 bucket_name must be configured.");
  }

  const durableObject = config?.durable_objects?.bindings?.find(
    (item) => item?.name === "AppAgent",
  );
  if (!durableObject) {
    errors.push("wrangler.jsonc must bind the AppAgent Durable Object.");
  } else {
    requireEqual(
      "wrangler.jsonc AppAgent class_name",
      durableObject.class_name,
      "AppAgent",
    );
  }

  const hasDurableObjectMigration = Array.isArray(config?.migrations)
    ? config.migrations.some((migration) =>
        migration?.new_sqlite_classes?.includes("AppAgent"),
      )
    : false;
  if (!hasDurableObjectMigration) {
    errors.push(
      "wrangler.jsonc must include a SQLite Durable Object migration for AppAgent.",
    );
  }
}

function verifyNoLocalOrStagingScripts(label, scripts) {
  if (!scripts || typeof scripts !== "object") {
    errors.push(`${label} scripts must be configured.`);
    return;
  }

  for (const name of FORBIDDEN_PRODUCTION_SCRIPT_NAMES) {
    if (scripts[name]) {
      errors.push(
        `${label} must not define ${JSON.stringify(name)}; deploy directly to production Cloudflare.`,
      );
    }
  }

  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      continue;
    }
    if (startsLocalDevServer(command)) {
      errors.push(
        `${label} script ${JSON.stringify(name)} must not start a local dev server.`,
      );
    }
    if (targetsStaging(name, command)) {
      errors.push(
        `${label} script ${JSON.stringify(name)} must not target staging.`,
      );
    }
    if (loadsLocalEnvFiles(command)) {
      errors.push(
        `${label} script ${JSON.stringify(name)} must not load local env files.`,
      );
    }
  }
}

function verifyPackageConfig(config) {
  requireEqual(
    "package.json scripts.deploy",
    config?.scripts?.deploy,
    "pnpm run verify:stack && pnpm run typecheck && pnpm run provision:production && pnpm run verify:production-config && pnpm run build && pnpm run lint && pnpm run d1:migrations:apply:production && wrangler deploy",
  );
  requireEqual(
    "package.json scripts.typecheck",
    config?.scripts?.typecheck,
    "pnpm run generate-routes && pnpm run cf-typegen && tsc -p . --noEmit --pretty false",
  );
  requireEqual(
    "package.json scripts.d1:migrations:apply:production",
    config?.scripts?.["d1:migrations:apply:production"],
    "wrangler d1 migrations apply ghostbuild-cloudflare-app --remote",
  );
  requireEqual(
    "package.json scripts.provision:production",
    config?.scripts?.["provision:production"],
    "node scripts/provision-cloudflare-production.mjs",
  );
  requireEqual(
    "package.json scripts.verify:stack",
    config?.scripts?.["verify:stack"],
    "node scripts/verify-stack-alignment.mjs",
  );
  requireEqual(
    "package.json scripts.verify:production-config",
    config?.scripts?.["verify:production-config"],
    "node scripts/verify-production-config.mjs",
  );
  requireEqual(
    "package.json scripts.lint",
    config?.scripts?.lint,
    "eslint src vite.config.ts --max-warnings=0",
  );
  if (!config?.devDependencies?.["jsonc-parser"]) {
    errors.push(
      "package.json must include jsonc-parser for production config verification.",
    );
  }
  if (!config?.devDependencies?.["eslint"]) {
    errors.push("package.json must include eslint for production linting.");
  }
  if (!config?.devDependencies?.["typescript-eslint"]) {
    errors.push(
      "package.json must include typescript-eslint for production linting.",
    );
  }
  verifyNoLocalOrStagingScripts("package.json", config?.scripts);
}

function verifyProvisionScript() {
  const content = readTextConfig(
    "scripts/provision-cloudflare-production.mjs",
    "scripts/provision-cloudflare-production.mjs",
  );
  if (!content) {
    return;
  }

  errors.push(
    ...findMissingProvisionScriptPatternErrors(
      content,
      "scripts/provision-cloudflare-production.mjs",
    ),
  );

  if (startsLocalDevServer(content)) {
    errors.push(
      "scripts/provision-cloudflare-production.mjs must not start local dev servers.",
    );
  }

  if (targetsStaging(content)) {
    errors.push(
      "scripts/provision-cloudflare-production.mjs must not target staging.",
    );
  }

  if (loadsLocalEnvFiles(content)) {
    errors.push(
      "scripts/provision-cloudflare-production.mjs must not load local env files.",
    );
  }
}

verifyWorkerConfig(readJsoncConfig("wrangler.jsonc", "wrangler.jsonc"));
verifyPackageConfig(readJsonConfig("package.json", "package.json"));
verifyProvisionScript();

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
