import type { WebContainer } from '@webcontainer/api';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { npmInstallToolParameters, splitPackageSpecs } from 'ghostbuild-agent/tools/npmInstall';
import { cleanBuildOutput } from 'ghostbuild-agent/utils/shell';
import { ContainerBootState, waitForContainerBootState } from '~/lib/stores/containerBootState';
import { streamOutput } from '~/utils/process';
import { packageInstallErrorMessage } from './errors';

export async function runNpmInstall(args: {
  invocation: GhostbuildToolInvocation;
  container: WebContainer;
  abortSignal: AbortSignal;
  onOutput: (output: string) => void;
}): Promise<string> {
  try {
    const input = npmInstallToolParameters.parse(args.invocation.args);
    args.abortSignal.throwIfAborted();
    await waitForContainerBootState(ContainerBootState.READY);
    args.abortSignal.throwIfAborted();
    const installProcess = await args.container.spawn('pnpm', ['add', ...splitPackageSpecs(input.packages)]);
    const killInstall = () => installProcess.kill();
    args.abortSignal.addEventListener('abort', killInstall, { once: true });
    try {
      if (args.abortSignal.aborted) {
        killInstall();
        args.abortSignal.throwIfAborted();
      }
      const { output, exitCode } = await streamOutput(installProcess, {
        onOutput: args.onOutput,
        debounceMs: 50,
      });
      const cleanedOutput = cleanBuildOutput(output);
      if (exitCode !== 0) {
        throw new Error(`pnpm add failed with exit code ${exitCode}: ${cleanedOutput}`);
      }
      return cleanedOutput;
    } finally {
      args.abortSignal.removeEventListener('abort', killInstall);
    }
  } catch (error) {
    return packageInstallErrorMessage(error);
  }
}
