import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const generatedPaths = [
  '.tanstack',
  '.wrangler',
  'dist',
  'worker-configuration.d.ts',
  'package-lock.json',
  'app/routeTree.gen.ts',
  'template/.tanstack',
  'template/.wrangler',
  'template/dist',
  'template/package-lock.json',
  'template/worker-configuration.d.ts',
  'template/src/routeTree.gen.ts',
];

for (const path of generatedPaths) {
  rmSync(resolve(rootDir, path), { force: true, recursive: true });
}
