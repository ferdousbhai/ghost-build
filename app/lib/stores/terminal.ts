import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { atom, type WritableAtom } from 'nanostores';
import type { ITerminal, TerminalInitializationOptions } from '~/types/terminal';
import { newGhostbuildShellProcess } from '~/utils/ghostbuild-shell';
import { newShellProcess } from '~/utils/interactive-terminal';
import { coloredText } from '~/utils/terminal';
import { workbenchCurrentView } from './workbench-ui-state';
import {
  activeTerminalTabStore,
  APP_SHELL_TAB_INDEX,
  isWorkerBuildTerminalVisibleStore,
  WORKER_BUILD_TAB_INDEX,
} from './terminalTabs';
import { toast } from 'sonner';
import { ContainerBootState, waitForBootStepCompleted, waitForContainerBootState } from './containerBootState';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';

const logger = createScopedLogger('TerminalStore');
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class TerminalStore {
  #webcontainer: Promise<WebContainer>;
  #terminals: WebContainerProcess[] = [];
  #appShellTerminal = newGhostbuildShellProcess();
  #deployTerminal = newGhostbuildShellProcess();
  #appPreviewServerStarted = false;
  #appPreviewCommand = 'pnpm run dev';
  showTerminal: WritableAtom<boolean> = import.meta.hot?.data.showTerminal ?? atom(false);

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;

    if (import.meta.hot) {
      import.meta.hot.data.showTerminal = this.showTerminal;
    }
  }
  toggleTerminal(value?: boolean) {
    this.showTerminal.set(value !== undefined ? value : !this.showTerminal.get());
  }

  async attachAppShellTerminal(terminal: ITerminal, options?: TerminalInitializationOptions) {
    try {
      const wc = await this.#webcontainer;
      await this.#appShellTerminal.init(wc, terminal);
      if (options?.startPreviewServer) {
        await this.startAppPreviewServer(options.previewCommand);
      }
    } catch (error) {
      logger.error('Failed to initialize app shell terminal:', error);
      terminal.write(coloredText.red('Failed to spawn terminal shell\n\n') + errorMessage(error));
      return;
    }
  }

  async startAppPreviewServer(command = 'pnpm run dev') {
    if (this.#appPreviewServerStarted) {
      return;
    }

    this.#appPreviewCommand = command;
    this.#appPreviewServerStarted = true;

    try {
      await waitForContainerBootState(ContainerBootState.READY);
      await this.#appShellTerminal.startCommand(command, { allowLocalDevServer: true });
    } catch (error) {
      this.#appPreviewServerStarted = false;
      throw error;
    }
  }

  async stopAppPreviewServer() {
    if (!this.#appPreviewServerStarted) {
      return false;
    }

    await this.#appShellTerminal.interrupt();
    this.#appPreviewServerStarted = false;

    return true;
  }

  async restartAppPreviewServer(command = this.#appPreviewCommand) {
    await this.#appShellTerminal.interrupt();
    this.#appPreviewServerStarted = false;
    await this.startAppPreviewServer(command);
  }

  async buildWorker(shouldRunWorkerBuild: boolean) {
    if (!shouldRunWorkerBuild) {
      return;
    }

    // We want all the code to be there, but do not need to wait for "READY"
    await waitForBootStepCompleted(ContainerBootState.STARTING_BACKUP);
    isWorkerBuildTerminalVisibleStore.set(true);
    activeTerminalTabStore.set(WORKER_BUILD_TAB_INDEX);

    await this.#deployTerminal.executeCommand('clear');
    const result = await this.#deployTerminal.executeCommand('pnpm run build');

    if (result.exitCode !== 0) {
      toast.error('Failed to build the Cloudflare Worker. Check the build logs for details.');
      workbenchCurrentView.set('code');
      activeTerminalTabStore.set(WORKER_BUILD_TAB_INDEX);
      return;
    }

    isWorkerBuildTerminalVisibleStore.set(false);
    activeTerminalTabStore.set(APP_SHELL_TAB_INDEX);
    toast.success('Cloudflare Worker build completed');
  }

  async attachDeployTerminal(terminal: ITerminal, options?: TerminalInitializationOptions) {
    try {
      const wc = await this.#webcontainer;
      await this.#deployTerminal.init(wc, terminal);
      if (options?.isReload) {
        await this.buildWorker(options.shouldRunWorkerBuild ?? false);
      }
    } catch (error) {
      logger.error('Failed to initialize deploy terminal:', error);
      terminal.write(coloredText.red('Failed to spawn deploy terminal shell\n\n') + errorMessage(error));
      return;
    }
  }

  async attachTerminal(terminal: ITerminal) {
    try {
      const shellProcess = await newShellProcess(await this.#webcontainer, terminal);
      this.#terminals.push(shellProcess);
    } catch (error) {
      terminal.write(coloredText.red('Failed to spawn shell\n\n') + errorMessage(error));
      return;
    }
  }

  onTerminalResize(cols: number, rows: number) {
    for (const process of this.#terminals) {
      process.resize({ cols, rows });
    }
  }
}
