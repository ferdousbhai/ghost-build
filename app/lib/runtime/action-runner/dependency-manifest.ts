type PackageManifest = {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
};

export function addRequestedDependencies(packageJson: string, packageSpecs: string[]): string {
  if (packageSpecs.length === 0) {
    return packageJson;
  }
  const manifest = JSON.parse(packageJson) as PackageManifest;
  const requestedDependencies = Object.fromEntries(packageSpecs.map(splitRegistryPackageSpec));
  return `${JSON.stringify(
    {
      ...manifest,
      dependencies: {
        ...manifest.dependencies,
        ...requestedDependencies,
      },
    },
    null,
    2,
  )}\n`;
}

export function findPackagesNeedingInstall(packageJson: string, packageSpecs: string[]): string[] {
  const manifest = JSON.parse(packageJson) as PackageManifest & {
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const installedDependencies = {
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.dependencies,
  };
  return packageSpecs.filter((spec) => {
    const [name, selector] = splitRegistryPackageSpec(spec);
    const installedSelector = installedDependencies[name];
    return installedSelector === undefined || (selector !== 'latest' && selector !== installedSelector);
  });
}

function splitRegistryPackageSpec(spec: string): [name: string, selector: string] {
  const selectorIndex = spec.startsWith('@') ? spec.indexOf('@', spec.indexOf('/') + 1) : spec.indexOf('@');
  return selectorIndex === -1 ? [spec, 'latest'] : [spec.slice(0, selectorIndex), spec.slice(selectorIndex + 1)];
}
