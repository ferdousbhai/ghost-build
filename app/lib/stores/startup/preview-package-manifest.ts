import type { WebContainer } from '@webcontainer/api';

const PACKAGE_JSON = 'package.json';
const PACKAGE_LOCK = 'package-lock.json';

const PREVIEW_OMITTED_DEPENDENCIES = new Set([
  '@ai-sdk/provider',
  '@ai-sdk/react',
  '@cloudflare/ai-chat',
  '@tanstack/react-start',
  'agents',
  'ai',
  'workers-ai-provider',
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
  'eslint',
  'eslint-plugin-react-hooks',
  'eslint-plugin-react-refresh',
  'globals',
  'jsonc-parser',
  'typescript',
  'typescript-eslint',
  'wrangler',
  'yaml',
]);

const PREVIEW_DEV_DEPENDENCY_OVERRIDES = new Map([
  ['@vitejs/plugin-react', '5.2.0'],
  ['vite', '7.3.6'],
]);

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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
      devDependencies: omitDependencies(
        manifest.devDependencies,
        PREVIEW_OMITTED_DEV_DEPENDENCIES,
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

  if (!root) {
    return packageLock;
  }

  return `${JSON.stringify(
    {
      ...lock,
      packages: {
        ...lock.packages,
        '': {
          ...root,
          dependencies: previewManifest.dependencies,
          devDependencies: previewManifest.devDependencies,
        },
      },
    },
    null,
    2,
  )}\n`;
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
): Promise<T> {
  const packageLock = await readOptionalFile(container, PACKAGE_LOCK);
  try {
    await container.fs.writeFile(PACKAGE_JSON, createPreviewPackageJson(packageJson));
    if (packageLock !== null) {
      await container.fs.writeFile(PACKAGE_LOCK, createPreviewPackageLock(packageJson, packageLock));
    }
    return await operation();
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
  overrides: ReadonlyMap<string, string> = new Map(),
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies ?? {})
      .filter(([name]) => !omitted.has(name))
      .map(([name, version]) => [name, overrides.get(name) ?? version]),
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
