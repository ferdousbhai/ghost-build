import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(rootDir, 'template');
const ignoredNames = new Set(['dist', 'node_modules', '.wrangler']);

function run(cwd, args, env = process.env) {
  const result = spawnSync('pnpm', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

function requireFailure(cwd, args) {
  const result = spawnSync('pnpm', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: process.env });
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    throw new Error(`pnpm ${args.join(' ')} unexpectedly succeeded.`);
  }
}

export async function verifyTemplate() {
  const tempDir = await mkdtemp(join(tmpdir(), 'ghostbuild-template-'));
  try {
    await cp(sourceDir, tempDir, {
      recursive: true,
      filter: (path) => path === sourceDir || !ignoredNames.has(basename(path)),
    });
    run(tempDir, ['install', '--frozen-lockfile']);
    run(tempDir, ['run', 'cf-typegen']);
    run(tempDir, ['run', 'verify:stack']);
    run(tempDir, ['run', 'verify:production-config', '--', '--allow-unprovisioned']);
    run(tempDir, ['run', 'typecheck']);
    run(tempDir, ['run', 'lint']);
    run(tempDir, ['run', 'build']);
    run(tempDir, ['exec', 'wrangler', 'deploy', '--dry-run']);
    run(tempDir, ['run', 'build'], { ...process.env, GHOSTBUILD_PREVIEW: '1' });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function verifyWorkerTemplateProfile() {
  const tempDir = await mkdtemp(join(tmpdir(), 'ghostbuild-worker-template-'));
  try {
    await cp(sourceDir, tempDir, {
      recursive: true,
      filter: (path) => path === sourceDir || !ignoredNames.has(basename(path)),
    });
    const stalePackagePath = join(tempDir, 'package.json');
    const stalePackage = JSON.parse(await readFile(stalePackagePath, 'utf8'));
    stalePackage.ghostbuild = { projectType: 'worker' };
    await writeFile(stalePackagePath, `${JSON.stringify(stalePackage, null, 2)}\n`);
    requireFailure(tempDir, ['run', 'verify:stack']);
    await convertToWorkerProfile(tempDir);
    run(tempDir, ['install', '--lockfile-only']);
    run(tempDir, ['install', '--frozen-lockfile']);
    run(tempDir, ['run', 'verify:stack']);
    run(tempDir, ['run', 'typecheck']);
    run(tempDir, ['run', 'lint']);
    run(tempDir, ['run', 'build']);
    if (!existsSync(join(tempDir, 'dist/worker/server.js'))) {
      throw new Error('Worker-only template build did not produce dist/worker/server.js.');
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function convertToWorkerProfile(tempDir) {
  const packagePath = join(tempDir, 'package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const retainedDevDependencies = [
    '@cloudflare/workers-types',
    '@eslint/js',
    '@types/node',
    'eslint',
    'globals',
    'jsonc-parser',
    'typescript',
    'typescript-eslint',
    'wrangler',
  ];
  pkg.ghostbuild = { projectType: 'worker' };
  pkg.scripts = {
    dev: 'wrangler dev',
    preview: 'wrangler dev',
    build: 'wrangler deploy src/server.ts --dry-run --outdir dist/worker --config wrangler.jsonc',
    deploy: 'pnpm run verify:stack && pnpm run typecheck && pnpm run build && pnpm run lint && wrangler deploy',
    'cf-typegen': 'node scripts/cf-typegen.mjs',
    typecheck: 'pnpm run cf-typegen && tsc -p . --noEmit --pretty false',
    'verify:stack': 'node scripts/verify-stack-alignment.mjs',
    lint: 'eslint src --max-warnings=0',
  };
  pkg.dependencies = {};
  pkg.devDependencies = Object.fromEntries(retainedDevDependencies.map((name) => [name, pkg.devDependencies[name]]));
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  const wrangler = parse(await readFile(join(tempDir, 'wrangler.jsonc'), 'utf8'));
  delete wrangler.ai;
  delete wrangler.d1_databases;
  delete wrangler.r2_buckets;
  delete wrangler.durable_objects;
  delete wrangler.migrations;
  await writeFile(join(tempDir, 'wrangler.jsonc'), `${JSON.stringify(wrangler, null, 2)}\n`);
  await writeFile(
    join(tempDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        include: ['src/**/*.ts', 'worker-configuration.d.ts'],
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2022'],
          strict: true,
          noEmit: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          types: ['./worker-configuration.d.ts'],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(tempDir, 'eslint.config.js'),
    `import js from "@eslint/js";\nimport globals from "globals";\nimport tseslint from "typescript-eslint";\n\nexport default tseslint.config(\n  { ignores: ["dist", "node_modules", ".wrangler", "worker-configuration.d.ts"] },\n  js.configs.recommended,\n  ...tseslint.configs.recommended,\n  { files: ["src/**/*.ts"], languageOptions: { globals: globals.serviceworker } },\n);\n`,
  );
  await rm(join(tempDir, 'src'), { recursive: true, force: true });
  await mkdir(join(tempDir, 'src'), { recursive: true });
  await writeFile(
    join(tempDir, 'src/server.ts'),
    `export default {\n  fetch(): Response {\n    return new Response("Hello from a framework-free Worker");\n  },\n} satisfies ExportedHandler<Env>;\n`,
  );
  await Promise.all([
    rm(join(tempDir, 'migrations'), { recursive: true, force: true }),
    rm(join(tempDir, 'vite.config.ts'), { force: true }),
  ]);
}

if (process.argv.includes('--worker-only')) {
  await verifyWorkerTemplateProfile();
} else {
  await verifyTemplate();
  await verifyWorkerTemplateProfile();
}
