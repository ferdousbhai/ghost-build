import { GENERATED_PROJECT_PNPM_VERSION } from '../../ghostbuild-agent/cloudflare-computer';
import { CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS } from './operation-lease-policy';

const COMPUTERD_ROOT = '/tmp/ghostbuild-computer';
// Immutable linux/amd64 layer published by
// ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.1.
const COMPUTERD_LAYER_DIGEST = 'sha256:7d54afd24f340c562357091403ee2dca004c0ce99d3970f32a03300602e19c47';

export const COMPUTERD_BINARY = `${COMPUTERD_ROOT}/usr/local/bin/computerd`;

/**
 * The toolchain bootstrap is a network package installation into the same
 * container the project's own installs run in, so it shares their ceiling
 * rather than declaring another number (#131). The production defect was the
 * opposite shape: the bootstrap was effectively bounded at 30 seconds by
 * @cloudflare/sandbox's hardcoded `DEFAULT_CONNECT_TIMEOUT_MS` — its exec
 * launch aborts when the capnweb upgrade to a cold container takes longer —
 * a ceiling far below every one declared in this repository.
 */
export const CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS = CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS;

/** Downloading and verifying the pinned computerd layer from GHCR. */
export const COMPUTERD_BOOTSTRAP_TIMEOUT_MS = 5 * 60_000;

/** Health probing, POST /connect, and the /ws upgrade that follow the bootstraps. */
const CONTAINER_CONNECT_STAGES_MARGIN_MS = 2 * 60_000;

/**
 * @cloudflare/computer's CloudflareContainerBackend arms its whole connect
 * deadline before calling `host.start()`, so both bootstraps spend from this
 * same budget. Derive it as the sum of the stages it must cover, so the vendor
 * deadline cannot silently undercut a stage budget declared here (the #127
 * guard shape, pinned by test).
 */
export const CONTAINER_CONNECT_TIMEOUT_MS =
  CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS + COMPUTERD_BOOTSTRAP_TIMEOUT_MS + CONTAINER_CONNECT_STAGES_MARGIN_MS;

/** Pacing between bootstrap attempts, not a ceiling: the stage budget is. */
export const BOOTSTRAP_RETRY_DELAY_MS = 5_000;

/** An interrupted bootstrap names itself instead of surfacing as a bare vendor abort (#131). */
export class ContainerToolchainBootstrapError extends Error {
  constructor(
    readonly stage: string,
    budgetMs: number,
    attempts: number,
    cause: Error,
  ) {
    super(
      `The container ${stage} bootstrap did not complete within its ${Math.round(budgetMs / 1_000)}s budget ` +
        `(${attempts} attempt${attempts === 1 ? '' : 's'}): ${cause.message} ` +
        `The bootstrap is idempotent and the workspace retries it automatically.`,
      { cause },
    );
    this.name = 'ContainerToolchainBootstrapError';
  }
}

/**
 * Run one bootstrap stage until it succeeds or its budget is spent.
 *
 * Both bootstrap commands are idempotent by construction — they install only
 * when the pinned version or binary is absent — so retrying after any failure
 * is safe. The failure this exists for is @cloudflare/sandbox aborting an exec
 * launch after its hardcoded 30-second control-connection timeout while the
 * container is still starting; the SDK itself classifies that abort as a
 * transient startup error, and without a retry it became a durable dead end
 * for the workspace (#131).
 */
export async function runIdempotentBootstrapStage(options: {
  stage: string;
  budgetMs: number;
  attempt: (remainingMs: number) => Promise<void>;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}): Promise<void> {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.budgetMs;
  let attempts = 0;
  // Assigned on every path that reaches the throw: the loop body either
  // returns from a successful attempt or records the failure first.
  let lastError!: Error;
  do {
    attempts += 1;
    try {
      await options.attempt(Math.max(1, deadline - now()));
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (deadline - now() <= BOOTSTRAP_RETRY_DELAY_MS) {
      break;
    }
    await delay(BOOTSTRAP_RETRY_DELAY_MS);
  } while (now() < deadline);
  throw new ContainerToolchainBootstrapError(options.stage, options.budgetMs, attempts, lastError);
}

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
