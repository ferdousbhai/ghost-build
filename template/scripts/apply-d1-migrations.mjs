import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

const config = parse(readFileSync("wrangler.jsonc", "utf8"));
const bindings = (config?.d1_databases ?? [])
  .map((database) => database?.binding)
  .filter((binding) => binding === "DB" || binding === "AGENT_SECURITY_DB");

for (const binding of bindings) {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "d1", "migrations", "apply", binding, "--remote"],
    { stdio: "inherit" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`D1 migration failed for ${binding}.`);
  }
}
