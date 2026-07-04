import { useEffect } from 'react';
import { ContainerBootState, setContainerBootState, waitForBootStepCompleted } from '~/lib/stores/containerBootState';
import { webcontainer } from '~/lib/webcontainer';
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
import { FILE_EVENTS_DEBOUNCE_MS } from '~/lib/stores/files';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';

const TEMPLATE_URL = '/template-snapshot-276d1c57.bin';
const logger = createScopedLogger('ContainerSetup');
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

export function useNewChatContainerSetup() {
  useEffect(() => {
    const runSetup = async () => {
      try {
        await waitForBootStepCompleted(ContainerBootState.STARTING);
        await setupContainer({ snapshotUrl: TEMPLATE_URL, allowPnpmInstallFailure: false });
      } catch (error) {
        toast.error('Failed to setup Ghostbuild environment. Try reloading the page.');
        setContainerBootState(ContainerBootState.ERROR, toError(error));
      }
    };
    void runSetup();
  }, []);
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
        await waitForBootStepCompleted(ContainerBootState.STARTING);
        let snapshotUrl = await executeDataOperation(api.snapshot.getSnapshotUrl, { chatId: loadedChatId, sessionId });
        if (!snapshotUrl) {
          logger.warn(`Existing chat ${loadedChatId} has no snapshot. Loading the base template.`);
          snapshotUrl = TEMPLATE_URL;
        }
        await setupContainer({ snapshotUrl, allowPnpmInstallFailure: true });
      } catch (error) {
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
    throw new Error(`Failed to download snapshot (${resp.statusText}): ${resp.statusText}`);
  }
  const compressed = await resp.arrayBuffer();
  const decompressed = decompressWithLz4(new Uint8Array(compressed));

  const container = await webcontainer;
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
  // This is a bit racy, but we need to flush the current file events before
  // deciding that we're synced up to the current update counter. Sleep for
  // twice the batching interval.
  await new Promise((resolve) => setTimeout(resolve, FILE_EVENTS_DEBOUNCE_MS * 2));
  const currentChatSyncState = chatSyncState.get();
  if (currentChatSyncState.savedFileUpdateCounter === null) {
    const fileUpdateCounter = getFileUpdateCounter();
    chatSyncState.set({
      ...currentChatSyncState,
      savedFileUpdateCounter: fileUpdateCounter,
    });
  }
}
