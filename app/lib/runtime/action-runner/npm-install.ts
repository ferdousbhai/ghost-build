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
import { prepareWebContainerPackageManagers } from '~/lib/webcontainer/pnpm';
import { withPreviewPackageManifest } from '~/lib/stores/startup/preview-package-manifest';

const DEPENDENCY_COMMAND_TIMEOUT_MS = 120_000;

type PackageManifest = {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
};

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
    await prepareWebContainerPackageManagers(args.container);
    const packageJson = await args.container.fs.readFile('package.json', 'utf-8');
    const packageJsonWithRequestedDependencies = addRequestedDependencies(packageJson, packages);
    await withPreviewPackageManifest(
      args.container,
      packageJsonWithRequestedDependencies,
      async () => {
        await runCommand({
          container: args.container,
          command: ['npm', 'install'],
          displayName: 'npm install (browser preview)',
          abortSignal: args.abortSignal,
          onOutput: args.onOutput,
          timeoutMs: DEPENDENCY_COMMAND_TIMEOUT_MS,
        });
      },
      { persistPreviewLock: true },
    );
    return toolSuccess(
      syncLockfile
        ? 'Synchronized the browser preview dependencies with package.json.'
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

function addRequestedDependencies(packageJson: string, packageSpecs: string[]): string {
  if (packageSpecs.length === 0) {
    return packageJson;
  }

  const manifest = JSON.parse(packageJson) as PackageManifest;
  const requestedDependencies = Object.fromEntries(packageSpecs.map(splitRegistryPackageSpec));

  return `${JSON.stringify(
    {
      ...manifest,
      dependencies: {
        ...manifest.dependencies,
        ...requestedDependencies,
      },
    },
    null,
    2,
  )}\n`;
}

function splitRegistryPackageSpec(spec: string): [name: string, selector: string] {
  const selectorIndex = spec.startsWith('@') ? spec.indexOf('@', spec.indexOf('/') + 1) : spec.indexOf('@');

  if (selectorIndex === -1) {
    return [spec, 'latest'];
  }

  return [spec.slice(0, selectorIndex), spec.slice(selectorIndex + 1)];
}
