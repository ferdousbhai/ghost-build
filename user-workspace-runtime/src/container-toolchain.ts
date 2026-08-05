import { GENERATED_PROJECT_PNPM_VERSION } from '../../ghostbuild-agent/cloudflare-computer';

const COMPUTERD_ROOT = '/tmp/ghostbuild-computer';
// Immutable linux/amd64 layer published by
// ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.1.
const COMPUTERD_LAYER_DIGEST = 'sha256:7d54afd24f340c562357091403ee2dca004c0ce99d3970f32a03300602e19c47';

export const COMPUTERD_BINARY = `${COMPUTERD_ROOT}/usr/local/bin/computerd`;

export function containerToolchainBootstrapCommand(): string {
  const expectedVersion = shellQuote(GENERATED_PROJECT_PNPM_VERSION);
  return strictSubshellCommand([
    `if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm --version)" != ${expectedVersion} ]; then`,
    `  npm install --global pnpm@${GENERATED_PROJECT_PNPM_VERSION} --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/`,
    'fi',
    `test "$(pnpm --version)" = ${expectedVersion}`,
  ]);
}

export function computerdBootstrapCommand(): string {
  const tokenUrl =
    'https://ghcr.io/token?service=ghcr.io&scope=repository:cloudflare/computer-computerd-linux-x64:pull';
  const blobUrl = `https://ghcr.io/v2/cloudflare/computer-computerd-linux-x64/blobs/${COMPUTERD_LAYER_DIGEST}`;
  return strictSubshellCommand([
    `if [ ! -x ${shellQuote(COMPUTERD_BINARY)} ]; then`,
    `  mkdir -p ${shellQuote(COMPUTERD_ROOT)}`,
    `  token="$(curl -fsSL ${shellQuote(tokenUrl)} | jq -er .token)"`,
    `  curl -fsSL -H "Authorization: Bearer $token" -o ${shellQuote(`${COMPUTERD_ROOT}/layer.tgz`)} ${shellQuote(blobUrl)}`,
    `  echo ${shellQuote(`${COMPUTERD_LAYER_DIGEST.slice('sha256:'.length)}  ${COMPUTERD_ROOT}/layer.tgz`)} | sha256sum -c -`,
    `  tar -xzf ${shellQuote(`${COMPUTERD_ROOT}/layer.tgz`)} -C ${shellQuote(COMPUTERD_ROOT)}`,
    `  chmod 0755 ${shellQuote(COMPUTERD_BINARY)}`,
    'fi',
    `test -x ${shellQuote(COMPUTERD_BINARY)}`,
  ]);
}

export function strictSubshellCommand(lines: readonly string[]): string {
  return ['(', 'set -eu', ...lines, ')'].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
