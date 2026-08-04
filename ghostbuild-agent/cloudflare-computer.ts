// Computer 0.1.1 declares itself preview-only. Keep the package, schemas, and
// backend contract pinned together until a reviewed upgrade changes all three.
export const CLOUDFLARE_COMPUTER_VERSION = '0.1.1';

export const COMPUTER_TOOL_NAMES = ['read', 'ls', 'write', 'edit', 'exec'] as const;
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number];

export const COMPUTER_SHELL_BACKEND_IDS = ['worker-shell', 'container-shell'] as const;
export type ComputerShellBackend = (typeof COMPUTER_SHELL_BACKEND_IDS)[number];

export const COMPUTER_DEFAULT_SHELL_BACKEND = 'worker-shell' satisfies ComputerShellBackend;
export const COMPUTER_CONTAINER_SHELL_BACKEND = 'container-shell' satisfies ComputerShellBackend;

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
