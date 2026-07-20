type ForbiddenProductionShellCommand = {
  reason: string;
  pattern: RegExp;
};

const forbiddenProductionShellCommands: ForbiddenProductionShellCommand[] = [
  {
    reason: 'start Wrangler dev',
    pattern: /\bwrangler\s+(?:pages\s+)?dev\b/i,
  },
  {
    reason: 'start Vite dev',
    pattern: /(?:^|[;&|]\s*)vite(?:\s+(?:dev|--host)\b|\s*$)/i,
  },
  {
    reason: 'start Vite dev through a package executor',
    pattern: /\b(?:(?:pnpm|npm|yarn|bun)\s+(?:exec\s+)?vite|npx\s+vite|bunx\s+vite)(?!\s+build\b)\b/i,
  },
  {
    reason: 'start a local package script',
    pattern: /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?(?:dev|start|preview)\b/i,
  },
  {
    reason: 'target staging',
    pattern: /\bstaging\b/i,
  },
];

export function findForbiddenProductionShellCommand(command: string) {
  const normalizedCommand = command.trim();
  return normalizedCommand
    ? forbiddenProductionShellCommands.find(({ pattern }) => pattern.test(normalizedCommand))
    : undefined;
}

export function assertProductionShellCommandAllowed(command: string) {
  const forbiddenCommand = findForbiddenProductionShellCommand(command);
  if (!forbiddenCommand) {
    return;
  }

  throw new Error(
    `Local dev-server and staging commands are disabled for Ghostbuild projects: ${forbiddenCommand.reason}. Deploy directly to the production Cloudflare Worker with pnpm run deploy.`,
  );
}
