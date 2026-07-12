import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

const rootDir = process.env.GHOSTBUILD_PROVISION_ROOT
  ? resolve(process.env.GHOSTBUILD_PROVISION_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(rootDir, "wrangler.jsonc");
const PLACEHOLDER_D1_ID = "00000000-0000-0000-0000-000000000000";
const isDryRun = process.argv.includes("--dry-run");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function compactLines(lines) {
  return lines.filter((line) => line).join("\n");
}

function readConfig() {
  const raw = readFileSync(configPath, "utf8");
  const parseErrors = [];
  const config = parse(raw, parseErrors, { allowTrailingComma: true });

  if (parseErrors.length > 0) {
    fail(
      parseErrors
        .map(
          (error) =>
            `wrangler.jsonc has invalid JSONC: ${printParseErrorCode(error.error)} at offset ${error.offset}.`,
        )
        .join("\n"),
    );
  }

  return { raw, config };
}

export function getBinding(config, collectionName, bindingName) {
  const collection = config?.[collectionName];
  if (!Array.isArray(collection)) {
    fail(`wrangler.jsonc ${collectionName} must be an array.`);
  }

  const index = collection.findIndex(
    (binding) => binding?.binding === bindingName,
  );
  if (index === -1) {
    fail(
      `wrangler.jsonc must contain ${collectionName} binding ${bindingName}.`,
    );
  }

  return { binding: collection[index], index };
}

function runWrangler(args, options = {}) {
  if (isDryRun) {
    console.log(`[dry-run] pnpm wrangler ${args.join(" ")}`);
    return { stdout: "", stderr: "", status: 0 };
  }

  const result = spawnSync("pnpm", ["wrangler", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0 && !options.allowFailure) {
    fail(
      compactLines([
        `pnpm wrangler ${args.join(" ")} failed with exit code ${result.status}.`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]),
    );
  }

  return result;
}

export function parseJsonOutput(stdout, command) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    fail(`${command} returned empty output.`);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const parsed = parseEmbeddedJson(trimmed);
    if (parsed !== undefined) {
      return parsed;
    }
    fail(`${command} did not return parseable JSON.`);
  }
}

function parseEmbeddedJson(output) {
  for (let start = 0; start < output.length; start++) {
    const first = output[start];
    if (first !== "[" && first !== "{") {
      continue;
    }
    if (!startsAtJsonLine(output, start)) {
      continue;
    }

    const last = first === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < output.length; index++) {
      const char = output[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === first) {
        depth++;
      } else if (char === last) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(output.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  return undefined;
}

function startsAtJsonLine(output, start) {
  for (let index = start - 1; index >= 0; index--) {
    const char = output[index];
    if (char === "\n" || char === "\r") {
      return true;
    }
    if (char !== " " && char !== "\t") {
      return false;
    }
  }

  return true;
}

export function d1DatabaseId(database) {
  return database?.uuid ?? database?.database_id ?? database?.id;
}

export function d1DatabaseName(database) {
  return database?.name ?? database?.database_name;
}

function listD1Databases() {
  if (isDryRun) {
    return [];
  }
  const result = runWrangler(["d1", "list", "--json"]);
  const databases = parseJsonOutput(result.stdout, "wrangler d1 list --json");
  if (!Array.isArray(databases)) {
    fail("wrangler d1 list --json returned an unexpected shape.");
  }
  return databases;
}

function ensureD1Database(d1) {
  const databaseName = d1.binding?.database_name;
  if (!databaseName) {
    fail("wrangler.jsonc D1 database_name must be configured.");
  }

  const configuredId = d1.binding?.database_id;
  const hasConfiguredId = configuredId && configuredId !== PLACEHOLDER_D1_ID;
  const databases = listD1Databases();
  const configuredDatabase = hasConfiguredId
    ? databases.find((database) => d1DatabaseId(database) === configuredId)
    : undefined;
  if (configuredDatabase) {
    console.log(
      `D1 database ${databaseName} is already configured as ${configuredId}.`,
    );
    return configuredId;
  }

  if (hasConfiguredId && databases.length > 0) {
    fail(
      `Configured D1 database_id ${configuredId} was not found in the Cloudflare account.`,
    );
  }

  let database = databases.find(
    (candidate) => d1DatabaseName(candidate) === databaseName,
  );
  if (!database) {
    runWrangler(["d1", "create", databaseName]);
    database = listD1Databases().find(
      (candidate) => d1DatabaseName(candidate) === databaseName,
    );
  }

  const databaseId = d1DatabaseId(database);
  if (!databaseId) {
    if (isDryRun) {
      console.log(
        `[dry-run] Would create or reuse D1 database ${databaseName} and update wrangler.jsonc.`,
      );
      return PLACEHOLDER_D1_ID;
    }
    fail(`Unable to determine D1 database_id for ${databaseName}.`);
  }

  return databaseId;
}

export function setD1DatabaseId(raw, d1Index, databaseId) {
  if (!databaseId || databaseId === PLACEHOLDER_D1_ID) {
    return raw;
  }

  const edits = modify(
    raw,
    ["d1_databases", d1Index, "database_id"],
    databaseId,
    {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: "\n",
      },
    },
  );
  return applyEdits(raw, edits);
}

function updateD1DatabaseId(raw, d1Index, databaseId) {
  const nextRaw = setD1DatabaseId(raw, d1Index, databaseId);
  if (nextRaw !== raw) {
    writeFileSync(configPath, nextRaw);
    console.log(`Updated wrangler.jsonc D1 database_id to ${databaseId}.`);
  }
  return nextRaw;
}

export function r2BucketExists(output, bucketName) {
  const expectedBucketName = bucketName.trim();
  if (!expectedBucketName) {
    return false;
  }

  return output.split("\n").some((line) => {
    const trimmedLine = line.trim();
    if (trimmedLine === expectedBucketName) {
      return true;
    }

    const cells = trimmedLine.includes("│")
      ? trimmedLine.split("│")
      : trimmedLine.split(/\s+/);
    return cells.some((cell) => cell.trim() === expectedBucketName);
  });
}

function ensureR2Bucket(r2) {
  const bucketName = r2.binding?.bucket_name;
  if (!bucketName) {
    fail("wrangler.jsonc R2 bucket_name must be configured.");
  }

  if (isDryRun) {
    console.log(`[dry-run] Would ensure R2 bucket ${bucketName} exists.`);
    return;
  }

  const listResult = runWrangler(["r2", "bucket", "list"]);
  if (r2BucketExists(listResult.stdout, bucketName)) {
    console.log(`R2 bucket ${bucketName} already exists.`);
    return;
  }

  const createResult = runWrangler(["r2", "bucket", "create", bucketName], {
    allowFailure: true,
  });
  const combinedOutput = `${createResult.stdout}\n${createResult.stderr}`;
  if (
    createResult.status !== 0 &&
    !/already exists|exists already|bucket.*exists/i.test(combinedOutput)
  ) {
    fail(
      compactLines([
        `pnpm wrangler r2 bucket create ${bucketName} failed with exit code ${createResult.status}.`,
        createResult.stdout?.trim(),
        createResult.stderr?.trim(),
      ]),
    );
  }
  console.log(`R2 bucket ${bucketName} is available.`);
}

export function main() {
  const { raw, config } = readConfig();
  const d1 = getBinding(config, "d1_databases", "DB");
  const r2 = getBinding(config, "r2_buckets", "APP_STORAGE");

  const databaseId = ensureD1Database(d1);
  updateD1DatabaseId(raw, d1.index, databaseId);
  ensureR2Bucket(r2);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
