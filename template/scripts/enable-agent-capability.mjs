import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Enable the protected Agent/Workers AI capability without hand-editing four configuration surfaces. */
export async function enableAgentCapability(rootDir = scriptRoot) {
  const capability = JSON.parse(
    await readFile(resolve(rootDir, "agent-capability.json"), "utf8"),
  );
  const packagePath = resolve(rootDir, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.dependencies = Object.fromEntries(
    Object.entries({
      ...packageJson.dependencies,
      ...capability.dependencies,
    }).sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const licensePolicyPath = resolve(
    rootDir,
    "scripts/production-license-policy.json",
  );
  const licensePolicy = JSON.parse(await readFile(licensePolicyPath, "utf8"));
  licensePolicy.metadataOnlyPackageAllowlist = [
    ...new Set([
      ...(licensePolicy.metadataOnlyPackageAllowlist ?? []),
      ...capability.metadataOnlyPackageAllowlist,
    ]),
  ].sort((left, right) => left.localeCompare(right));
  await writeFile(
    licensePolicyPath,
    `${JSON.stringify(licensePolicy, null, 2)}\n`,
  );

  const wranglerPath = resolve(rootDir, "wrangler.jsonc");
  let wranglerSource = await readFile(wranglerPath, "utf8");
  const wrangler = parse(wranglerSource);
  const d1Databases = [
    ...(wrangler.d1_databases ?? []).filter(
      (database) => database?.binding !== "AGENT_SECURITY_DB",
    ),
    capability.wrangler.agentSecurityDatabase,
  ];
  for (const [path, value] of [
    [["main"], capability.wrangler.main],
    [["ai"], capability.wrangler.ai],
    [["d1_databases"], d1Databases],
    [["durable_objects"], capability.wrangler.durable_objects],
    [["exports"], capability.wrangler.exports],
    [["triggers"], capability.wrangler.triggers],
  ]) {
    wranglerSource = applyEdits(
      wranglerSource,
      modify(wranglerSource, path, value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
  }
  await writeFile(wranglerPath, wranglerSource);

  const tsconfigPath = resolve(rootDir, "tsconfig.json");
  let tsconfigSource = await readFile(tsconfigPath, "utf8");
  const tsconfig = parse(tsconfigSource);
  const exclusions = (tsconfig.exclude ?? []).filter(
    (path) => !capability.typescriptExcludesToRemove.includes(path),
  );
  tsconfigSource = applyEdits(
    tsconfigSource,
    modify(
      tsconfigSource,
      ["exclude"],
      exclusions.length > 0 ? exclusions : undefined,
      {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      },
    ),
  );
  await writeFile(tsconfigPath, tsconfigSource);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await enableAgentCapability();
}
