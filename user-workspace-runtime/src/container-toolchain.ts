import { GENERATED_PROJECT_PNPM_VERSION } from '../../ghostbuild-agent/cloudflare-computer';

export function containerToolchainBootstrapCommand(): string {
  const expectedVersion = shellQuote(GENERATED_PROJECT_PNPM_VERSION);
  return [
    'set -eu',
    `if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm --version)" != ${expectedVersion} ]; then`,
    `  npm install --global pnpm@${GENERATED_PROJECT_PNPM_VERSION} --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/`,
    'fi',
    `test "$(pnpm --version)" = ${expectedVersion}`,
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
