import {
  isForbiddenStackDependencyPackageName,
  isRegistryPackageSpec,
  packageNameFromInstallSpec,
} from 'ghostbuild-agent/utils/stackPolicy';
import { slashPath } from './pathNames';

const packageDependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const forbiddenPackageManagerPolicyFields = ['dependenciesMeta', 'overrides', 'pnpm', 'resolutions'] as const;

type PackageDependencySection = (typeof packageDependencySections)[number];

type PackageManifest = Partial<Record<PackageDependencySection, unknown>> & Record<string, unknown>;

type ForbiddenGeneratedPackageDependency = {
  section: PackageDependencySection;
  packageName: string;
};

type InvalidGeneratedPackageSource = {
  section: PackageDependencySection;
  packageName: string;
  versionSpec: unknown;
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

export function findInvalidGeneratedPackageSources(manifest: PackageManifest) {
  const invalidSources: InvalidGeneratedPackageSource[] = [];
  for (const section of packageDependencySections) {
    const dependencies = manifest[section];
    if (!isPlainRecord(dependencies)) {
      continue;
    }
    for (const [packageName, versionSpec] of Object.entries(dependencies)) {
      if (typeof versionSpec !== 'string' || !isRegistryPackageSpec(`${packageName}@${versionSpec}`)) {
        invalidSources.push({ section, packageName, versionSpec });
      }
    }
  }
  return invalidSources;
}

export function findForbiddenGeneratedPackageManagerPolicyFields(manifest: PackageManifest) {
  return forbiddenPackageManagerPolicyFields.filter((field) => Object.hasOwn(manifest, field));
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
  if (forbiddenDependencies.length > 0) {
    const formattedDependencies = forbiddenDependencies
      .map(({ section, packageName }) => `${section}.${packageName}`)
      .join(', ');
    throw new Error(
      `Generated package.json must not depend on ${formattedDependencies}. Use Cloudflare Workers AI and TanStack/Cloudflare APIs instead.`,
    );
  }

  const invalidSources = findInvalidGeneratedPackageSources(manifest);
  if (invalidSources.length > 0) {
    const formattedDependencies = invalidSources
      .map(({ section, packageName }) => `${section}.${packageName}`)
      .join(', ');
    throw new Error(
      `Generated package.json dependencies must use npm registry versions: ${formattedDependencies}. URL, Git, file, link, and workspace sources are not allowed.`,
    );
  }

  const forbiddenPolicyFields = findForbiddenGeneratedPackageManagerPolicyFields(manifest);
  if (forbiddenPolicyFields.length > 0) {
    throw new Error(
      `Generated package.json must not override dependency resolution or build policy through: ${forbiddenPolicyFields.join(', ')}. Use the reviewed pnpm-workspace.yaml policy and npm registry dependency versions instead.`,
    );
  }
}
