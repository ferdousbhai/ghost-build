import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await run(process.execPath, ['make-bootstrap-snapshot.js']);
await run(process.execPath, ['scripts/build-user-workspace-runtime.mjs']);

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(new Error(`${args[0]} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? 'unknown'}`}.`));
    });
  });
}
