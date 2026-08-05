export const ISOLATED_PROJECT_ROOT = '/tmp/ghostbuild-projects';

type DeploymentConfigPaths = {
  main: string;
  assets?: { directory: string };
  d1_databases?: Array<{ migrations_dir: string }>;
};

export function createIsolatedProjectCommand(args: {
  projectRoot: string;
  isolatedRoot: string;
  quote: (value: string) => string;
}): string {
  const source = args.quote(args.projectRoot);
  const destination = args.quote(args.isolatedRoot);
  return [
    'set -eu',
    `rm -rf ${destination}`,
    `mkdir -p ${destination}`,
    `tar -C ${source} --exclude='./node_modules' --exclude='./dist' --exclude='./.output' --exclude='./.tanstack' --exclude='./.wrangler' -cf - . | tar -C ${destination} -xf -`,
    `if find ${destination} ! -type d ! -type f -print -quit | grep -q .; then printf '%s\n' 'Project source cannot contain non-regular files.' >&2; rm -rf ${destination}; exit 1; fi`,
  ].join('\n');
}

export function createContainerDirectoryCommand(args: {
  directory: string;
  command: string;
  quote: (value: string) => string;
}): string {
  return `cd ${args.quote(args.directory)} &&\n${args.command}`;
}

export function rebaseDeploymentConfigPaths<T extends DeploymentConfigPaths>(
  config: T,
  args: { projectRoot: string; isolatedRoot: string },
): T {
  const rebase = (path: string): string => {
    const suffix = path.slice(args.projectRoot.length);
    if (!path.startsWith(`${args.projectRoot}/`) || !suffix.startsWith('/')) {
      throw new Error(`Deployment path is outside the project root: ${path}`);
    }
    return `${args.isolatedRoot}${suffix}`;
  };

  return {
    ...config,
    main: rebase(config.main),
    ...(config.assets ? { assets: { ...config.assets, directory: rebase(config.assets.directory) } } : {}),
    ...(config.d1_databases
      ? {
          d1_databases: config.d1_databases.map((database) => ({
            ...database,
            migrations_dir: rebase(database.migrations_dir),
          })),
        }
      : {}),
  };
}

export function relativeIsolatedPath(root: string, absolutePath: string): string {
  const normalizedRoot = root.replace(/\/+$/, '');
  if (!absolutePath.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Isolated file is outside its expected root: ${absolutePath}`);
  }
  return absolutePath.slice(normalizedRoot.length + 1);
}
