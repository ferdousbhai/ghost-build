import { GHOSTBUILD_PREVIEW_COMMAND } from '~/lib/preview-config';
import type { TerminalInitializationOptions } from '~/types/terminal';

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
