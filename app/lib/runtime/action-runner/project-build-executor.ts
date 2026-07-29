import type { WebContainer } from '@webcontainer/api';
import { runCommand } from './command';

export type ProjectBuildCommand = {
  command: string[];
  displayName?: string;
  abortSignal: AbortSignal;
  onOutput: (output: string) => void;
  timeoutMs: number;
};

/**
 * Narrow execution seam for commands that do not depend on the browser
 * preview. The default implementation stays in WebContainer; a short-lived
 * remote sandbox can implement the same contract without gaining arbitrary
 * workspace or shell access.
 */
export interface ProjectBuildExecutor {
  readonly environment: 'browser' | 'remote-sandbox';
  run(command: ProjectBuildCommand): Promise<void>;
}

export function createWebContainerBuildExecutor(container: WebContainer): ProjectBuildExecutor {
  return {
    environment: 'browser',
    run: (args) => runCommand({ ...args, container }),
  };
}
