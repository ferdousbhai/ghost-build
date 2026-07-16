import { useEffect } from 'react';
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
import { streamOutput } from '~/utils/process';
import { cleanTerminalOutput } from 'ghostbuild-agent/utils/shell';
import { toast } from 'sonner';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { getFileUpdateCounter } from '~/lib/stores/fileUpdateCounter';
import { chatSyncState } from './chatSyncState';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';

const TEMPLATE_URL = '/template-snapshot-d409e423.bin';
const logger = createScopedLogger('ContainerSetup');
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

export function useNewChatContainerSetup(enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const runSetup = async () => {
      try {
        void startWebcontainer();
        await waitForBootStepCompleted(ContainerBootState.STARTING);
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
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    if (!loadedChatId) {
      return;
    }
    const runSetup = async () => {
      try {
        void startWebcontainer();
        await waitForBootStepCompleted(ContainerBootState.STARTING);
        let snapshotUrl = await executeDataOperation(api.snapshot.getSnapshotUrl, { chatId: loadedChatId, sessionId });
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
  const resp = await fetch(options.snapshotUrl);
  if (!resp.ok) {
    throw new Error(`Failed to download snapshot (${resp.status}): ${resp.statusText}`);
  }
  const compressed = await resp.arrayBuffer();
  const decompressed = decompressWithLz4(new Uint8Array(compressed));

  const container = await startWebcontainer();
  await container.mount(decompressed);

  // After loading the snapshot, we need to load the files into the FilesStore since
  // we won't receive file events for snapshot files.
  await workbenchStore.prewarmWorkdir(container);

  setContainerBootState(ContainerBootState.DOWNLOADING_DEPENDENCIES);
  const pnpm = await container.spawn('pnpm', ['install', '--no-frozen-lockfile']);
  const { output, exitCode } = await streamOutput(pnpm);
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
  await initializeFileSystemBackup();

  setContainerBootState(ContainerBootState.READY);
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
