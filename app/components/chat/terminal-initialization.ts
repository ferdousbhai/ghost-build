import type { TerminalInitializationOptions } from '~/types/terminal';

const GHOSTBUILD_PREVIEW_COMMAND = 'GHOSTBUILD_PREVIEW=1 pnpm run dev';

export function createTerminalInitializationOptions(args: {
  isReload: boolean;
  shouldRunWorkerBuild: boolean;
}): TerminalInitializationOptions {
  return {
    ...args,
    startPreviewServer: true,
    previewCommand: GHOSTBUILD_PREVIEW_COMMAND,
  };
}
