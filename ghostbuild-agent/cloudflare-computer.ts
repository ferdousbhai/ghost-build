import type { CreateAIToolsOptions } from '@cloudflare/computer/tools';

// Computer 0.1.1 declares itself preview-only. Keep the package, schemas, and
// backend contract pinned together until a reviewed upgrade changes all three.
export const CLOUDFLARE_COMPUTER_VERSION = '0.1.1';

export const COMPUTER_TOOL_NAMES = ['read', 'ls', 'write', 'edit', 'exec'] as const;
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number];

export const COMPUTER_SHELL_BACKEND_IDS = ['worker-shell', 'container-shell'] as const;
export type ComputerShellBackend = (typeof COMPUTER_SHELL_BACKEND_IDS)[number];

export const COMPUTER_DEFAULT_SHELL_BACKEND = 'worker-shell' satisfies ComputerShellBackend;
export const COMPUTER_CONTAINER_SHELL_BACKEND = 'container-shell' satisfies ComputerShellBackend;

export const COMPUTER_SYNC_PENDING_ERROR_CODE = 'workspace_sync_pending';
export const COMPUTER_SYNC_EXHAUSTED_ERROR_CODE = 'workspace_sync_exhausted';

export type ComputerSyncUnconfirmedToolResult = {
  kind: 'workspace-sync-unconfirmed';
  version: 1;
  acknowledgement: 'pending';
  status: 'pending' | 'exhausted';
  code: typeof COMPUTER_SYNC_PENDING_ERROR_CODE | typeof COMPUTER_SYNC_EXHAUSTED_ERROR_CODE;
  error: string;
};

/** Workers RPC may preserve only an exception message, so the stable code is embedded in both fields. */
export function isComputerSyncUnconfirmedError(error: unknown): boolean {
  return syncUnconfirmedCode(error) !== null;
}

export function computerSyncUnconfirmedToolResult(value: unknown): ComputerSyncUnconfirmedToolResult | null {
  const code = syncUnconfirmedCode(value);
  if (!code) {
    return null;
  }
  const message = syncUnconfirmedMessage(value, code);
  return {
    kind: 'workspace-sync-unconfirmed',
    version: 1,
    acknowledgement: 'pending',
    status: code === COMPUTER_SYNC_EXHAUSTED_ERROR_CODE ? 'exhausted' : 'pending',
    code,
    error: message.slice(-4_000),
  };
}

export function computerSyncUnconfirmedError(value: unknown): Error | null {
  const result = computerSyncUnconfirmedToolResult(value);
  if (!result) {
    return null;
  }
  return Object.assign(new Error(result.error), { name: 'WorkspaceSyncPendingError', code: result.code });
}

function syncUnconfirmedCode(
  value: unknown,
): typeof COMPUTER_SYNC_PENDING_ERROR_CODE | typeof COMPUTER_SYNC_EXHAUSTED_ERROR_CODE | null {
  const candidate =
    value instanceof Error
      ? { code: (value as Error & { code?: unknown }).code, message: value.message }
      : typeof value === 'object' && value !== null
        ? {
            code: (value as { code?: unknown }).code,
            message:
              typeof (value as { error?: unknown }).error === 'string'
                ? (value as { error: string }).error
                : typeof (value as { message?: unknown }).message === 'string'
                  ? (value as { message: string }).message
                  : '',
          }
        : { code: undefined, message: typeof value === 'string' ? value : '' };
  if (
    candidate.code === COMPUTER_SYNC_PENDING_ERROR_CODE ||
    candidate.message.startsWith(`[${COMPUTER_SYNC_PENDING_ERROR_CODE}]`)
  ) {
    return COMPUTER_SYNC_PENDING_ERROR_CODE;
  }
  if (
    candidate.code === COMPUTER_SYNC_EXHAUSTED_ERROR_CODE ||
    candidate.message.startsWith(`[${COMPUTER_SYNC_EXHAUSTED_ERROR_CODE}]`)
  ) {
    return COMPUTER_SYNC_EXHAUSTED_ERROR_CODE;
  }
  return null;
}

function syncUnconfirmedMessage(
  value: unknown,
  code: typeof COMPUTER_SYNC_PENDING_ERROR_CODE | typeof COMPUTER_SYNC_EXHAUSTED_ERROR_CODE,
): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'object' && value !== null) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === 'string') {
      return error;
    }
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return `[${code}] Computer synchronization is not yet durably acknowledged.`;
}

export const COMPUTER_EXEC_APPLICATION_POLICY =
  'Ghostbuild policy: use exec for inspection and checks only. Do not use shell commands to change project source, configuration, dependency manifests, or lockfiles; use write, edit, or npmInstall so mutations remain visible to the build lifecycle.';

export const COMPUTER_TOOL_LIMITS = {
  readMaxBytes: 256 * 1024,
  readMaxLines: 2_000,
  mutationMaxBytes: 2 * 1024 * 1024,
  mutationReceiptMaxBytes: 64 * 1024,
  mutationDiffSummaryMaxBytes: 16 * 1024,
  mutationReceiptMaxPaths: 100,
  execMaxBytesPerStream: 64 * 1024,
} as const;

export const COMPUTER_SHELL_TOOL_OPTIONS = {
  defaultBackend: COMPUTER_DEFAULT_SHELL_BACKEND,
  backends: {
    [COMPUTER_DEFAULT_SHELL_BACKEND]: {
      description:
        'Fast just-bash shell in an isolated Worker with no public network. Use for grep, sed, awk, jq, sort, find, and other built-in text commands. It cannot run Node.js, pnpm, Wrangler, or arbitrary Linux binaries.',
    },
    [COMPUTER_CONTAINER_SHELL_BACKEND]: {
      description:
        'Cloudflare Container with full Linux userland, public network access, Node.js, pnpm, git, Wrangler, and build tools. Use when worker-shell does not provide the required command.',
    },
  },
} as const satisfies {
  defaultBackend: ComputerShellBackend;
  backends: Record<ComputerShellBackend, { description: string }>;
};

// Keep every optional createAITools capability explicit. In particular,
// publishing must not appear if the structural workspace later gains assets.
export const COMPUTER_AI_TOOL_OPTIONS = {
  assets: false,
  read: {
    maxBytes: COMPUTER_TOOL_LIMITS.readMaxBytes,
    maxLines: COMPUTER_TOOL_LIMITS.readMaxLines,
  },
  write: { maxBytes: COMPUTER_TOOL_LIMITS.mutationMaxBytes },
  edit: { maxBytes: COMPUTER_TOOL_LIMITS.mutationMaxBytes },
  shell: {
    ...COMPUTER_SHELL_TOOL_OPTIONS,
    maxBytes: COMPUTER_TOOL_LIMITS.execMaxBytesPerStream,
  },
} as const satisfies Omit<CreateAIToolsOptions, 'workspace'>;
