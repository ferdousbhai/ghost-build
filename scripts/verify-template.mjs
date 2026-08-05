import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import { listTemplateSourceFiles } from './template-source.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(rootDir, 'template');

function runExecutable(command, cwd, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

function run(cwd, args, env = process.env) {
  runExecutable('pnpm', cwd, args, env);
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
    await copyCanonicalTemplateSource(tempDir);
    const generatedBindingsPath = join(tempDir, 'worker-configuration.d.ts');
    if (existsSync(generatedBindingsPath)) {
      throw new Error('The canonical template source must not contain generated Worker binding types.');
    }
    run(tempDir, ['install', '--frozen-lockfile']);
    run(tempDir, ['audit', '--audit-level', 'moderate']);
    // Typecheck owns route and Worker-binding generation. Run it before stack
    // verification so a fresh snapshot does not depend on ignored local files.
    run(tempDir, ['run', 'typecheck']);
    if (!existsSync(generatedBindingsPath)) {
      throw new Error('Template typecheck did not generate worker-configuration.d.ts.');
    }
    run(tempDir, ['run', 'verify:stack']);
    run(tempDir, ['run', 'verify:production-config', '--', '--allow-unprovisioned']);
    run(tempDir, ['run', 'lint']);
    run(tempDir, ['run', 'build']);
    // Match the isolated production entrypoint, including pnpm's generated
    // NODE_PATH for Babel's virtual plugin resolution.
    run(tempDir, ['run', 'verify:licenses']);
    run(tempDir, ['exec', 'vite', 'build']);
    run(tempDir, ['run', 'verify:licenses:built']);
    await verifyResolvedProductionModulePolicy(tempDir);
    run(tempDir, ['exec', 'wrangler', 'deploy', '--dry-run']);
    run(tempDir, [
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--config',
      'wrangler.preview.jsonc',
    ]);
    await installIsolatedPreviewBindingProbe(tempDir);
    run(tempDir, ['run', 'build:isolated-preview']);
    await verifyIsolatedPreview(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function verifyIsolatedPreview(tempDir) {
  const port = 41_000 + Math.floor(Math.random() * 10_000);
  const output = [];
  const child = spawn(
    'pnpm',
    [
      'exec',
      'vite',
      'preview',
      '--mode',
      'ghostbuild-isolated-preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: tempDir,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let spawnError;
  const capture = (chunk) => {
    output.push(String(chunk));
    if (output.length > 100) {
      output.shift();
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', (error) => {
    spawnError = error;
  });
  try {
    const deadline = Date.now() + 45_000;
    let lastError = 'Preview did not start.';
    while (Date.now() < deadline) {
      if (spawnError) {
        throw spawnError;
      }
      if (child.exitCode !== null) {
        throw new Error(`Isolated Preview exited before becoming ready.\n${output.join('').slice(-8_000)}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) {
          const csp = response.headers.get('content-security-policy') ?? '';
          if (!csp.includes('frame-ancestors https://ghostbuild.dev')) {
            throw new Error(`Isolated Preview returned an unexpected CSP: ${csp}`);
          }
          if (response.headers.has('x-frame-options')) {
            throw new Error('Isolated Preview must not emit X-Frame-Options.');
          }
          await verifyIsolatedPreviewBindings(port);
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Isolated Preview did not become ready: ${lastError}\n${output.join('').slice(-8_000)}`);
  } finally {
    await terminateProcessGroup(child, exited);
  }
}

async function installIsolatedPreviewBindingProbe(tempDir) {
  const entryPath = join(tempDir, 'src', 'preview-server.ts');
  const entry = await readFile(entryPath, 'utf8');
  const fetchSignature = 'async fetch(request: Request) {';
  if (!entry.includes(fetchSignature)) {
    throw new Error('The isolated Preview entrypoint no longer has the expected fetch signature.');
  }
  const bindingProbe = `async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/__ghostbuild_verify_bindings") {
      const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      const key = \`ghostbuild-preview-\${crypto.randomUUID()}\`;
      await env.APP_STORAGE.put(key, "r2-ok");
      const object = await env.APP_STORAGE.get(key);
      const value = object ? await object.text() : null;
      await env.APP_STORAGE.delete(key);
      return Response.json({ d1: row?.ok === 1, r2: value === "r2-ok" });
    }`;
  await writeFile(entryPath, entry.replace(fetchSignature, bindingProbe));
}

async function verifyIsolatedPreviewBindings(port) {
  const response = await fetch(`http://127.0.0.1:${port}/__ghostbuild_verify_bindings`);
  if (!response.ok) {
    throw new Error(`Isolated Preview binding probe returned HTTP ${response.status}.`);
  }
  const result = await response.json();
  if (result?.d1 !== true || result?.r2 !== true) {
    throw new Error(`Isolated Preview binding probe failed: ${JSON.stringify(result)}`);
  }
}

async function terminateProcessGroup(child, exited) {
  if (child.exitCode !== null) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      child.kill('SIGTERM');
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) {
    if (process.platform === 'win32') {
      child.kill('SIGKILL');
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
    await exited;
  }
}

async function verifyResolvedProductionModulePolicy(tempDir) {
  const dependencyDir = join(tempDir, 'node_modules', 'innocent-runtime-helper');
  const routePath = join(tempDir, 'src', 'routes', 'index.tsx');
  const originalRoute = await readFile(routePath, 'utf8');
  await mkdir(dependencyDir, { recursive: true });
  await writeFile(
    join(dependencyDir, 'package.json'),
    `${JSON.stringify({ name: 'innocent-runtime-helper', version: '1.0.0', type: 'module', exports: './index.js' })}\n`,
  );
  await writeFile(
    routePath,
    `import { leakedBinding } from "innocent-runtime-helper";\nvoid leakedBinding;\n${originalRoute}`,
  );
  try {
    await writeFile(
      join(dependencyDir, 'index.js'),
      String.raw`export { env as leakedBinding } from "cloudflare:\x77orkers";` + '\n',
    );
    requireFailure(tempDir, ['run', 'build']);
    await writeFile(
      join(dependencyDir, 'index.js'),
      `export const leakedBinding = import("cloudflare:" + "workers");\n`,
    );
    requireFailure(tempDir, ['run', 'build']);
  } finally {
    await writeFile(routePath, originalRoute);
    await rm(dependencyDir, { recursive: true, force: true });
  }
}

export async function verifyWorkerTemplateProfile() {
  const tempDir = await mkdtemp(join(tmpdir(), 'ghostbuild-worker-template-'));
  try {
    await copyCanonicalTemplateSource(tempDir);
    const stalePackagePath = join(tempDir, 'package.json');
    const stalePackage = JSON.parse(await readFile(stalePackagePath, 'utf8'));
    stalePackage.ghostbuild = { projectType: 'worker' };
    await writeFile(stalePackagePath, `${JSON.stringify(stalePackage, null, 2)}\n`);
    // Isolate this assertion to stale web scripts; production typecheck generates
    // the real binding declarations before stack verification.
    await writeFile(join(tempDir, 'worker-configuration.d.ts'), 'interface Env {}\n');
    requireFailure(tempDir, ['run', 'verify:stack']);
    await rm(join(tempDir, 'worker-configuration.d.ts'), { force: true });
    await convertToWorkerProfile(tempDir);
    run(tempDir, ['install', '--lockfile-only']);
    run(tempDir, ['install', '--frozen-lockfile']);
    run(tempDir, ['audit', '--audit-level', 'moderate']);
    run(tempDir, ['run', 'typecheck']);
    run(tempDir, ['run', 'verify:stack']);
    run(tempDir, ['run', 'lint']);
    run(tempDir, ['run', 'build']);
    if (!existsSync(join(tempDir, 'dist/worker/server.js'))) {
      throw new Error('Worker-only template build did not produce dist/worker/server.js.');
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function copyCanonicalTemplateSource(targetDir) {
  for (const sourcePath of listTemplateSourceFiles(rootDir)) {
    const relativePath = relative(sourceDir, sourcePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`Template source escaped its root: ${sourcePath}`);
    }
    const targetPath = join(targetDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
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
    'yaml',
  ];
  pkg.ghostbuild = { projectType: 'worker' };
  pkg.scripts = {
    dev: 'wrangler dev',
    preview: 'wrangler dev',
    build: 'wrangler deploy src/server.ts --dry-run --outdir dist/worker --config wrangler.jsonc',
    deploy: 'pnpm run typecheck && pnpm run verify:stack && pnpm run build && pnpm run lint && wrangler deploy',
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
  delete wrangler.exports;
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
    rm(join(tempDir, 'agent-security-migrations'), { recursive: true, force: true }),
    rm(join(tempDir, 'migrations'), { recursive: true, force: true }),
    rm(join(tempDir, 'vite.config.ts'), { force: true }),
  ]);
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  if (process.argv.includes('--worker-only')) {
    await verifyWorkerTemplateProfile();
  } else {
    await verifyTemplate();
    await verifyWorkerTemplateProfile();
  }
}
