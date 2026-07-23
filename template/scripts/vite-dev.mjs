import { spawn } from "node:child_process";

const args = ["node_modules/vite/bin/vite.js", "dev", "--host", "0.0.0.0"];

if (process.env.GHOSTBUILD_PREVIEW === "1") {
  args.push("--config", "vite.preview.config.mjs");
}

const child = spawn(process.execPath, args, {
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code));
});

process.exitCode = exitCode ?? 1;
