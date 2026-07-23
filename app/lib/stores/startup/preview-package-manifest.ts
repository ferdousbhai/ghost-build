import type { WebContainer } from '@webcontainer/api';

const PACKAGE_JSON = 'package.json';
const PACKAGE_LOCK = 'package-lock.json';
const PREVIEW_PACKAGE_LOCK = 'preview-runtime/package-lock.json';
const PREVIEW_VITE_VERSION = '6.4.3';

const PREVIEW_OMITTED_DEPENDENCIES = new Set([
  '@ai-sdk/provider',
  '@ai-sdk/react',
  '@cloudflare/ai-chat',
  '@tanstack/react-router',
  '@tanstack/react-start',
  'agents',
  'ai',
  'workers-ai-provider',
  'zod',
]);

const PREVIEW_OMITTED_DEV_DEPENDENCIES = new Set([
  '@babel/core',
  '@cloudflare/vite-plugin',
  '@cloudflare/workers-types',
  '@eslint/js',
  '@tanstack/router-cli',
  '@types/node',
  '@types/react',
  '@types/react-dom',
  '@vitejs/plugin-react',
  'autoprefixer',
  'eslint',
  'eslint-plugin-react-hooks',
  'eslint-plugin-react-refresh',
  'globals',
  'jsonc-parser',
  'postcss',
  'tailwindcss',
  'typescript-eslint',
  'wrangler',
  'yaml',
]);

const PREVIEW_DEV_DEPENDENCY_OVERRIDES = new Map([['vite', PREVIEW_VITE_VERSION]]);

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
};

type PackageLock = {
  packages?: Record<string, PackageManifest>;
  [key: string]: unknown;
};

export function createPreviewPackageJson(packageJson: string): string {
  const manifest = JSON.parse(packageJson) as PackageManifest;
  return `${JSON.stringify(
    {
      ...manifest,
      dependencies: omitDependencies(manifest.dependencies, PREVIEW_OMITTED_DEPENDENCIES),
      devDependencies: overrideDependencies(
        omitDependencies(manifest.devDependencies, PREVIEW_OMITTED_DEV_DEPENDENCIES),
        PREVIEW_DEV_DEPENDENCY_OVERRIDES,
      ),
    },
    null,
    2,
  )}\n`;
}

export function createPreviewPackageLock(packageJson: string, packageLock: string): string {
  const previewManifest = JSON.parse(createPreviewPackageJson(packageJson)) as PackageManifest;
  const lock = JSON.parse(packageLock) as PackageLock;
  const root = lock.packages?.[''];

  if (!root || !lock.packages) {
    return packageLock;
  }

  const previewPackagePaths = collectReachablePackagePaths(lock.packages, previewManifest);

  return `${JSON.stringify(
    {
      ...lock,
      packages: Object.fromEntries(
        Object.entries(lock.packages)
          .filter(([path]) => path === '' || previewPackagePaths.has(path))
          .map(([path, entry]) => [
            path,
            path === ''
              ? {
                  ...root,
                  dependencies: previewManifest.dependencies,
                  devDependencies: previewManifest.devDependencies,
                }
              : entry,
          ]),
      ),
    },
    null,
    2,
  )}\n`;
}

function collectReachablePackagePaths(packages: Record<string, PackageManifest>, root: PackageManifest): Set<string> {
  const reachable = new Set<string>();
  const pending = Object.keys({
    ...root.dependencies,
    ...root.devDependencies,
    ...root.optionalDependencies,
  }).map((name) => ({ importerPath: '', name }));

  for (let index = 0; index < pending.length; index++) {
    const dependency = pending[index];
    const packagePath = resolvePackagePath(packages, dependency.importerPath, dependency.name);
    if (!packagePath || reachable.has(packagePath)) {
      continue;
    }

    reachable.add(packagePath);
    const entry = packages[packagePath];
    for (const name of Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
    })) {
      pending.push({ importerPath: packagePath, name });
    }
  }

  return reachable;
}

function resolvePackagePath(
  packages: Record<string, PackageManifest>,
  importerPath: string,
  dependencyName: string,
): string | undefined {
  let directory = importerPath;

  while (true) {
    const candidate = directory ? `${directory}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`;
    if (packages[candidate]) {
      return candidate;
    }

    const parentNodeModules = directory.lastIndexOf('/node_modules/');
    if (parentNodeModules >= 0) {
      directory = directory.slice(0, parentNodeModules);
    } else if (directory) {
      directory = '';
    } else {
      return undefined;
    }
  }
}

/**
 * npm uses package.json and package-lock.json in place. Give the browser cold
 * start a reduced, lockfile-synchronized preview graph, then restore the
 * complete deployment inputs before project generation, backup, or deployment
 * can observe them.
 */
export async function withPreviewPackageManifest<T>(
  container: Pick<WebContainer, 'fs'>,
  packageJson: string,
  operation: () => Promise<T>,
  options: { persistPreviewLock?: boolean } = {},
): Promise<T> {
  const packageLock = await readOptionalFile(container, PACKAGE_LOCK);
  const previewPackageLock = await readOptionalFile(container, PREVIEW_PACKAGE_LOCK);
  try {
    await container.fs.writeFile(PACKAGE_JSON, createPreviewPackageJson(packageJson));
    if (packageLock !== null) {
      await container.fs.writeFile(
        PACKAGE_LOCK,
        createPreviewPackageLock(packageJson, previewPackageLock ?? packageLock),
      );
    }
    const result = await operation();
    if (options.persistPreviewLock && packageLock !== null) {
      const installedPreviewLock = await readOptionalFile(container, PACKAGE_LOCK);
      if (installedPreviewLock !== null) {
        await container.fs.writeFile(PREVIEW_PACKAGE_LOCK, installedPreviewLock);
      }
    }
    return result;
  } finally {
    await container.fs.writeFile(PACKAGE_JSON, packageJson);
    if (packageLock === null) {
      await container.fs.rm(PACKAGE_LOCK, { force: true });
    } else {
      await container.fs.writeFile(PACKAGE_LOCK, packageLock);
    }
  }
}

function omitDependencies(
  dependencies: Record<string, string> | undefined,
  omitted: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(dependencies ?? {}).filter(([name]) => !omitted.has(name)));
}

function overrideDependencies(
  dependencies: Record<string, string>,
  overrides: ReadonlyMap<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, version]) => [name, overrides.get(name) ?? version]),
  );
}

async function readOptionalFile(container: Pick<WebContainer, 'fs'>, path: string): Promise<string | null> {
  try {
    return await container.fs.readFile(path, 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
