import { isForbiddenStackDependencyPackageName, packageNameFromInstallSpec } from 'ghostbuild-agent/utils/stackPolicy';
import { slashPath } from './pathNames';

const packageDependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

type PackageDependencySection = (typeof packageDependencySections)[number];

type PackageManifest = {
  [section in PackageDependencySection]?: unknown;
};

type ForbiddenGeneratedPackageDependency = {
  section: PackageDependencySection;
  packageName: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function packageJsonPath(filePath: string) {
  return slashPath(filePath).endsWith('/package.json') || filePath === 'package.json';
}

export function findForbiddenGeneratedPackageDependencies(manifest: PackageManifest) {
  const forbiddenDependencies: ForbiddenGeneratedPackageDependency[] = [];

  for (const section of packageDependencySections) {
    const dependencies = manifest[section];
    if (!isPlainRecord(dependencies)) {
      continue;
    }

    for (const [packageName, versionSpec] of Object.entries(dependencies)) {
      if (isForbiddenStackDependencyPackageName(packageName)) {
        forbiddenDependencies.push({ section, packageName });
        continue;
      }

      if (typeof versionSpec !== 'string' || !versionSpec.includes('npm:')) {
        continue;
      }

      const aliasedPackageName = packageNameFromInstallSpec(versionSpec);
      if (isForbiddenStackDependencyPackageName(aliasedPackageName)) {
        forbiddenDependencies.push({ section, packageName: aliasedPackageName });
      }
    }
  }

  return forbiddenDependencies;
}

export function assertValidGeneratedPackageJson(filePath: string, content: string) {
  if (!packageJsonPath(filePath)) {
    return;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    return;
  }

  if (!isPlainRecord(manifest)) {
    return;
  }

  const forbiddenDependencies = findForbiddenGeneratedPackageDependencies(manifest);
  if (forbiddenDependencies.length === 0) {
    return;
  }

  const formattedDependencies = forbiddenDependencies
    .map(({ section, packageName }) => `${section}.${packageName}`)
    .join(', ');

  throw new Error(
    `Generated package.json must not depend on ${formattedDependencies}. Use Cloudflare Workers AI and TanStack/Cloudflare APIs instead.`,
  );
}
