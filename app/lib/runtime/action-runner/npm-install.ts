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
import { prepareWebContainerPackageManagers, webContainerNpmEnvironment } from '~/lib/webcontainer/pnpm';
import { createPreviewPackageJson, withPreviewPackageManifest } from '~/lib/stores/startup/preview-package-manifest';

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
    const previewPackageJson = createPreviewPackageJson(packageJson);
    let installedPreviewPackageJson = previewPackageJson;
    await withPreviewPackageManifest(
      args.container,
      packageJson,
      async () => {
        await runCommand({
          container: args.container,
          command: ['npm', 'install', ...packages],
          displayName: 'npm install (browser preview)',
          abortSignal: args.abortSignal,
          onOutput: args.onOutput,
          env: webContainerNpmEnvironment(),
          timeoutMs: DEPENDENCY_COMMAND_TIMEOUT_MS,
        });
        installedPreviewPackageJson = await args.container.fs.readFile('package.json', 'utf-8');
      },
      { persistPreviewLock: true },
    );
    if (!syncLockfile) {
      await args.container.fs.writeFile(
        'package.json',
        mergeInstalledPreviewDependencies(packageJson, previewPackageJson, installedPreviewPackageJson),
      );
    }
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

function mergeInstalledPreviewDependencies(
  packageJson: string,
  previewPackageJson: string,
  installedPreviewPackageJson: string,
): string {
  const manifest = JSON.parse(packageJson) as PackageManifest;
  const preview = JSON.parse(previewPackageJson) as PackageManifest;
  const installed = JSON.parse(installedPreviewPackageJson) as PackageManifest;
  const dependencyChanges = Object.fromEntries(
    Object.entries(installed.dependencies ?? {}).filter(([name, version]) => preview.dependencies?.[name] !== version),
  );

  return `${JSON.stringify(
    {
      ...manifest,
      dependencies: {
        ...manifest.dependencies,
        ...dependencyChanges,
      },
    },
    null,
    2,
  )}\n`;
}
