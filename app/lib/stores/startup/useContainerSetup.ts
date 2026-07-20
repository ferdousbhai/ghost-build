import { useEffect, useRef } from 'react';
import {
  ContainerBootState,
  isUnsupportedRuntimeError,
  setContainerBootState,
  waitForBootStepCompleted,
} from '~/lib/stores/containerBootState';
import { startWebcontainer } from '~/lib/webcontainer';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { api } from '~/lib/cloudflare/data-api';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { decompressWithLz4 } from '~/lib/compression';
import { PROJECT_SNAPSHOT_LZ4_LIMITS } from '~/lib/compression-limits';
import { readBodyBytesWithLimit } from '~/lib/bounded-body';
import { streamOutput } from '~/utils/process';
import { cleanTerminalOutput } from 'ghostbuild-agent/utils/shell';
import { toast } from 'sonner';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { getFileUpdateCounter } from '~/lib/stores/fileUpdateCounter';
import { chatSyncState } from './chatSyncState';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { assertValidGeneratedPackageJson } from '~/utils/generatedPackageManifest';
import { assertSafeGeneratedPnpmWorkspace } from '~/utils/generatedPnpmWorkspace';
import { startupInstallArgs } from './dependency-install-policy';

const TEMPLATE_URL = '/template-snapshot-b20d96a1.bin';
const logger = createScopedLogger('ContainerSetup');
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
const WEBCONTAINER_BOOT_TIMEOUT_MS = 60_000;
const SNAPSHOT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEPENDENCY_INSTALL_TIMEOUT_MS = 120_000;
const WORKSPACE_STEP_TIMEOUT_MS = 30_000;

export function useNewChatContainerSetup(enabled: boolean) {
  const setupStarted = useRef(false);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (setupStarted.current) {
      return;
    }
    setupStarted.current = true;
    const runSetup = async () => {
      try {
        void startWebcontainer();
        await withTimeout(
          waitForBootStepCompleted(ContainerBootState.STARTING),
          WEBCONTAINER_BOOT_TIMEOUT_MS,
          'The browser workspace took too long to start.',
        );
        await setupContainer({ snapshotUrl: TEMPLATE_URL, allowPnpmInstallFailure: false });
      } catch (error) {
        if (isUnsupportedRuntimeError(error)) {
          return;
        }
        toast.error('Failed to setup Ghostbuild environment. Try reloading the page.');
        setContainerBootState(ContainerBootState.ERROR, toError(error));
      }
    };
    void runSetup();
  }, [enabled]);
}

export function useExistingChatContainerSetup(loadedChatId: string | undefined) {
  const sessionId = useSessionIdOrNullOrLoading();
  const setupStarted = useRef(false);
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    if (!loadedChatId) {
      return;
    }
    if (setupStarted.current) {
      return;
    }
    setupStarted.current = true;
    const runSetup = async () => {
      try {
        void startWebcontainer();
        await withTimeout(
          waitForBootStepCompleted(ContainerBootState.STARTING),
          WEBCONTAINER_BOOT_TIMEOUT_MS,
          'The browser workspace took too long to start.',
        );
        let snapshotUrl = await withTimeout(
          executeDataOperation(api.snapshot.getSnapshotUrl, { chatId: loadedChatId, sessionId }),
          WORKSPACE_STEP_TIMEOUT_MS,
          'Ghostbuild took too long to locate the project snapshot.',
        );
        if (!snapshotUrl) {
          logger.warn(`Existing chat ${loadedChatId} has no snapshot. Loading the base template.`);
          snapshotUrl = TEMPLATE_URL;
        }
        await setupContainer({ snapshotUrl, allowPnpmInstallFailure: true });
      } catch (error) {
        if (isUnsupportedRuntimeError(error)) {
          return;
        }
        toast.error('Failed to setup Ghostbuild environment. Try reloading the page.');
        setContainerBootState(ContainerBootState.ERROR, toError(error));
      }
    };
    void runSetup();
  }, [loadedChatId, sessionId]);
}

async function setupContainer(options: { snapshotUrl: string; allowPnpmInstallFailure: boolean }) {
  const controller = new AbortController();
  const downloadTimeout = setTimeout(() => controller.abort(), SNAPSHOT_DOWNLOAD_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(options.snapshotUrl, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('The project snapshot took too long to download.');
    }
    throw error;
  } finally {
    clearTimeout(downloadTimeout);
  }
  if (!resp.ok) {
    throw new Error(`Failed to download snapshot (${resp.status}): ${resp.statusText}`);
  }
  const compressed = await readBodyBytesWithLimit(
    resp,
    PROJECT_SNAPSHOT_LZ4_LIMITS.compressedBytes,
    'Project snapshot',
  );
  const decompressed = decompressWithLz4(compressed, PROJECT_SNAPSHOT_LZ4_LIMITS);

  const container = await withTimeout(
    startWebcontainer(),
    WORKSPACE_STEP_TIMEOUT_MS,
    'The browser workspace stopped responding.',
  );
  await withTimeout(
    container.mount(decompressed),
    WORKSPACE_STEP_TIMEOUT_MS,
    'The project snapshot took too long to load.',
  );

  // After loading the snapshot, we need to load the files into the FilesStore since
  // we won't receive file events for snapshot files.
  await withTimeout(
    workbenchStore.prewarmWorkdir(container),
    WORKSPACE_STEP_TIMEOUT_MS,
    'Ghostbuild took too long to index the project files.',
  );
  const packageJson = await withTimeout(
    container.fs.readFile('package.json', 'utf-8'),
    WORKSPACE_STEP_TIMEOUT_MS,
    'Ghostbuild took too long to inspect the project manifest.',
  );
  assertValidGeneratedPackageJson('package.json', packageJson);
  const pnpmWorkspace = await withTimeout(
    container.fs.readFile('pnpm-workspace.yaml', 'utf-8'),
    WORKSPACE_STEP_TIMEOUT_MS,
    'Ghostbuild took too long to inspect the dependency policy.',
  );
  assertSafeGeneratedPnpmWorkspace('pnpm-workspace.yaml', pnpmWorkspace);

  setContainerBootState(ContainerBootState.DOWNLOADING_DEPENDENCIES);
  let { output, exitCode } = await runPnpmInstall(container, startupInstallArgs('--frozen-lockfile'));
  if (exitCode !== 0 && options.allowPnpmInstallFailure) {
    logger.warn('Frozen dependency install failed; retrying while repairing the generated lockfile.');
    const repaired = await runPnpmInstall(container, startupInstallArgs('--no-frozen-lockfile'));
    output = `${output}\n${repaired.output}`;
    exitCode = repaired.exitCode;
  }
  logger.debug('pnpm install output', cleanTerminalOutput(output));

  if (exitCode !== 0) {
    if (!options.allowPnpmInstallFailure) {
      throw new Error(`pnpm install failed with exit code ${exitCode}: ${output}`);
    }

    toast.error(`Failed to install dependencies. Fix your package.json and tell Ghostbuild to redeploy.`, {
      duration: Infinity,
    });
    logger.error(`pnpm install failed with exit code ${exitCode}: ${output}`);
  }

  setContainerBootState(ContainerBootState.STARTING_BACKUP);
  await withTimeout(
    initializeFileSystemBackup(),
    WORKSPACE_STEP_TIMEOUT_MS,
    'Ghostbuild took too long to start project backup.',
  );

  setContainerBootState(ContainerBootState.READY);
}

async function runPnpmInstall(
  container: Awaited<ReturnType<typeof startWebcontainer>>,
  args: string[],
): Promise<{ output: string; exitCode: number }> {
  const pnpm = await withTimeout(
    container.spawn('pnpm', args),
    WORKSPACE_STEP_TIMEOUT_MS,
    'Ghostbuild could not start dependency installation.',
  );
  try {
    return await withTimeout(
      streamOutput(pnpm),
      DEPENDENCY_INSTALL_TIMEOUT_MS,
      'Dependency installation took too long.',
    );
  } catch (error) {
    pnpm.kill();
    throw error;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

async function initializeFileSystemBackup() {
  await workbenchStore.flushFileEvents();
  const currentChatSyncState = chatSyncState.get();
  if (currentChatSyncState.savedFileUpdateCounter === null) {
    const fileUpdateCounter = getFileUpdateCounter();
    chatSyncState.set({
      ...currentChatSyncState,
      savedFileUpdateCounter: fileUpdateCounter,
    });
  }
}
