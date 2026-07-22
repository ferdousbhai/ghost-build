import type { WebContainer } from '@webcontainer/api';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { npmInstallToolParameters, splitPackageSpecs } from 'ghostbuild-agent/tools/npmInstall';
import { ContainerBootState, waitForContainerBootState } from '~/lib/stores/containerBootState';
import { ActionCommandExecutionError, boundedErrorMessage } from './errors';
import { toolFailure, toolSuccess } from 'ghostbuild-agent/tool-result';
import { parseOperationDiagnostics, type DiagnosticsStore } from './diagnostics-store';
import { pageCoverage } from './bounded-pagination';
import { runCommand } from './command';
import { assertSafeGeneratedPnpmWorkspace } from '~/utils/generatedPnpmWorkspace';
import { prepareWebContainerPnpm, webContainerPnpmCommand, webContainerPnpmEnvironment } from '~/lib/webcontainer/pnpm';

const DEPENDENCY_COMMAND_TIMEOUT_MS = 120_000;
const NPM_REGISTRY = 'https://registry.npmjs.org/';

export async function runNpmInstall(args: {
  invocation: GhostbuildToolInvocation;
  container: WebContainer;
  abortSignal: AbortSignal;
  onOutput: (output: string) => void;
  diagnostics: DiagnosticsStore;
}) {
  let mode: 'add' | 'sync-lockfile' = 'add';
  let packages: string[] = [];
  try {
    const input = npmInstallToolParameters.parse(args.invocation.args);
    mode = input.mode ?? 'add';
    packages = splitPackageSpecs(input.packages ?? '');
    args.abortSignal.throwIfAborted();
    await waitForContainerBootState(ContainerBootState.READY);
    args.abortSignal.throwIfAborted();
    const workspace = await args.container.fs.readFile('pnpm-workspace.yaml', 'utf-8');
    assertSafeGeneratedPnpmWorkspace('pnpm-workspace.yaml', workspace);
    const syncLockfile = mode === 'sync-lockfile';
    const sourcePolicyArgs = ['--ignore-pnpmfile', `--registry=${NPM_REGISTRY}`];
    const commandArgs = syncLockfile
      ? ['install', '--lockfile-only', ...sourcePolicyArgs]
      : ['add', ...sourcePolicyArgs, ...packages];
    await prepareWebContainerPnpm(args.container);
    await runCommand({
      container: args.container,
      command: webContainerPnpmCommand(commandArgs),
      displayName: syncLockfile ? 'pnpm install --lockfile-only' : `pnpm add (${packages.length} packages)`,
      abortSignal: args.abortSignal,
      onOutput: args.onOutput,
      env: webContainerPnpmEnvironment(args.container),
      timeoutMs: DEPENDENCY_COMMAND_TIMEOUT_MS,
    });
    return toolSuccess(
      syncLockfile
        ? 'Synchronized pnpm-lock.yaml with package.json.'
        : `Installed ${packages.length} dependency package${packages.length === 1 ? '' : 's'}.`,
      { mode, exitCode: 0 },
    );
  } catch (error) {
    args.abortSignal.throwIfAborted();
    if (error instanceof ActionCommandExecutionError) {
      const diagnostics = parseOperationDiagnostics(error.output, { operation: 'dependency-install' });
      const syncLockfile = mode === 'sync-lockfile';
      const label = syncLockfile ? 'lockfile synchronization diagnostics' : 'dependency installation diagnostics';
      const { page, diagnosticsId } = args.diagnostics.start(label, diagnostics);
      const nextCursor = page.complete ? undefined : String(page.end);
      return toolFailure(
        `${error.message}${nextCursor ? ' Continue the structured diagnostics with getDiagnostics.' : ''}`,
        {
          mode,
          exitCode: error.exitCode,
          diagnostics: page.items,
          ...(diagnosticsId ? { diagnosticsId } : {}),
        },
        pageCoverage(page, nextCursor),
      );
    }
    return toolFailure(
      boundedErrorMessage(
        error,
        'Dependency installation failed with an unusually large internal error retained in developer logs.',
      ),
      { mode },
    );
  }
}
