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

function splitRegistryPackageSpec(spec: string): [name: string, selector: string] {
  const selectorIndex = spec.startsWith('@') ? spec.indexOf('@', spec.indexOf('/') + 1) : spec.indexOf('@');
  return selectorIndex === -1 ? [spec, 'latest'] : [spec.slice(0, selectorIndex), spec.slice(selectorIndex + 1)];
}
