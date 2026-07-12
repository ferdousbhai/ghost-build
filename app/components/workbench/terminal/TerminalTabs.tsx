import { useStore } from '@nanostores/react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { memo, useCallback, useEffect, useRef } from 'react';
import { Panel, type ImperativePanelHandle } from 'react-resizable-panels';
import { IconButton } from '~/components/ui/IconButton';
import { themeStore } from '~/lib/stores/theme';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { classNames } from '~/utils/classNames';
import { Terminal } from './Terminal';
import type { TerminalInitializationOptions } from '~/types/terminal';
import {
  activeTerminalTabStore,
  APP_SHELL_TAB_INDEX,
  isWorkerBuildTerminalVisibleStore,
  WORKER_BUILD_TAB_INDEX,
} from '~/lib/stores/terminalTabs';
import { CommandLineIcon } from '@heroicons/react/24/outline';
import { CaretDownIcon } from '@radix-ui/react-icons';
import { DEFAULT_TERMINAL_SIZE } from './constants';

const TERMINAL_INDEXES = [APP_SHELL_TAB_INDEX, WORKER_BUILD_TAB_INDEX, 2] as const;

export const TerminalTabs = memo(function TerminalTabs({
  isReload,
  previewCommand,
  shouldRunWorkerBuild,
  startPreviewServer,
}: TerminalInitializationOptions) {
  const showTerminal = useStore(workbenchStore.showTerminal);

  const terminalPanelRef = useRef<ImperativePanelHandle>(null);

  const activeTerminal = useStore(activeTerminalTabStore);
  const isWorkerBuildTerminalVisible = useStore(isWorkerBuildTerminalVisibleStore);

  useEffect(() => {
    const { current: terminal } = terminalPanelRef;

    if (!terminal) {
      return;
    }

    const isCollapsed = terminal.isCollapsed();

    if (!showTerminal && !isCollapsed) {
      terminal.collapse();
      return;
    }

    if (showTerminal && isCollapsed) {
      terminal.resize(DEFAULT_TERMINAL_SIZE);
    }
  }, [showTerminal]);

  return (
    <Panel
      id="terminal-panel"
      order={2}
      ref={terminalPanelRef}
      defaultSize={showTerminal ? DEFAULT_TERMINAL_SIZE : 0}
      minSize={10}
      collapsible
      onExpand={() => {
        workbenchStore.toggleTerminal(true);
      }}
      onCollapse={() => {
        workbenchStore.toggleTerminal(false);
      }}
    >
      <div className="h-full">
        <div className="flex h-full flex-col bg-bolt-elements-terminals-background">
          <div className="flex min-h-[34px] items-center gap-1.5 border-y bg-bolt-elements-background-depth-2 p-2">
            {TERMINAL_INDEXES.map((index) => {
              const isActive = activeTerminal === index;

              if (index === WORKER_BUILD_TAB_INDEX && !isWorkerBuildTerminalVisible) {
                return null;
              }

              return (
                <button
                  key={index}
                  className={classNames(
                    'flex items-center text-sm cursor-pointer gap-1.5 px-3 py-2 h-full whitespace-nowrap rounded-full',
                    {
                      'bg-bolt-elements-terminals-buttonBackground text-content-primary': isActive,
                      'bg-bolt-elements-background-depth-2 text-content-secondary hover:bg-bolt-elements-terminals-buttonBackground':
                        !isActive,
                    },
                  )}
                  onClick={() => activeTerminalTabStore.set(index)}
                >
                  <CommandLineIcon className="size-4" />
                  {terminalTabLabel(index)}
                </button>
              );
            })}
            <IconButton
              className="ml-auto"
              icon={<CaretDownIcon />}
              title="Close"
              size="md"
              onClick={() => workbenchStore.toggleTerminal(false)}
            />
          </div>
          {TERMINAL_INDEXES.map((index) => (
            <TerminalWrapper
              key={index}
              index={index}
              activeTerminal={activeTerminal}
              isReload={isReload}
              shouldRunWorkerBuild={shouldRunWorkerBuild}
              startPreviewServer={startPreviewServer}
              previewCommand={previewCommand}
            />
          ))}
        </div>
      </div>
    </Panel>
  );
});

function terminalTabLabel(index: number) {
  if (index === APP_SHELL_TAB_INDEX) {
    return 'Preview logs';
  }
  if (index === WORKER_BUILD_TAB_INDEX) {
    return 'Build logs';
  }
  return 'Shell';
}

function TerminalWrapper({
  index,
  activeTerminal,
  isReload,
  shouldRunWorkerBuild,
  startPreviewServer,
  previewCommand,
}: {
  index: number;
  activeTerminal: number;
  isReload?: boolean;
  shouldRunWorkerBuild?: boolean;
  startPreviewServer?: boolean;
  previewCommand?: string;
}) {
  const theme = useStore(themeStore);

  const onTerminalReady = useCallback(
    (terminal: XTerm) => {
      if (index === APP_SHELL_TAB_INDEX) {
        workbenchStore.attachAppShellTerminal(terminal, {
          startPreviewServer,
          previewCommand,
        });
        return;
      }

      if (index === WORKER_BUILD_TAB_INDEX) {
        workbenchStore.attachDeployTerminal(terminal, {
          isReload,
          shouldRunWorkerBuild,
        });
        return;
      }

      workbenchStore.attachTerminal(terminal);
    },
    [index, isReload, shouldRunWorkerBuild, startPreviewServer, previewCommand],
  );

  const onTerminalResize = useCallback((cols: number, rows: number) => {
    workbenchStore.onTerminalResize(cols, rows);
  }, []);

  return (
    <Terminal
      id={`terminal_${index}`}
      className={classNames('h-full overflow-hidden', {
        hidden: activeTerminal !== index,
      })}
      onTerminalReady={onTerminalReady}
      onTerminalResize={onTerminalResize}
      theme={theme}
      readonly={index === WORKER_BUILD_TAB_INDEX}
      visible={activeTerminal === index}
    />
  );
}
