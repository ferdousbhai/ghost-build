import { useStore } from '@nanostores/react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
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
import { CaretDownIcon, PlusIcon } from '@radix-ui/react-icons';
import { DEFAULT_TERMINAL_SIZE } from './constants';

const MAX_TERMINAL_INDEX = 5;

export const TerminalTabs = memo(function TerminalTabs(terminalInitializationOptions?: TerminalInitializationOptions) {
  const showTerminal = useStore(workbenchStore.showTerminal);

  const terminalPanelRef = useRef<ImperativePanelHandle>(null);

  const activeTerminal = useStore(activeTerminalTabStore);
  const [lastTerminalIndex, setLastTerminalIndex] = useState(2);

  const isWorkerBuildTerminalVisible = useStore(isWorkerBuildTerminalVisibleStore);

  const addTerminal = () => {
    const nextTerminalIndex = lastTerminalIndex + 1;
    if (nextTerminalIndex <= MAX_TERMINAL_INDEX) {
      setLastTerminalIndex(nextTerminalIndex);
      activeTerminalTabStore.set(nextTerminalIndex);
    }
  };

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

  const terminalIndexes = Array.from({ length: lastTerminalIndex + 1 }, (_, index) => index);

  return (
    <Panel
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
            {terminalIndexes.map((index) => {
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
            {lastTerminalIndex < MAX_TERMINAL_INDEX && (
              <IconButton icon={<PlusIcon />} size="md" onClick={addTerminal} />
            )}
            <IconButton
              className="ml-auto"
              icon={<CaretDownIcon />}
              title="Close"
              size="md"
              onClick={() => workbenchStore.toggleTerminal(false)}
            />
          </div>
          {terminalIndexes.map((index) => (
            <TerminalWrapper
              key={index}
              index={index}
              activeTerminal={activeTerminal}
              isReload={terminalInitializationOptions?.isReload}
              shouldRunWorkerBuild={terminalInitializationOptions?.shouldRunWorkerBuild}
            />
          ))}
        </div>
      </div>
    </Panel>
  );
});

function terminalTabLabel(index: number) {
  if (index === APP_SHELL_TAB_INDEX) {
    return 'App Shell';
  }
  if (index === WORKER_BUILD_TAB_INDEX) {
    return 'Worker Build';
  }
  return `Terminal ${index - 1}`;
}

function TerminalWrapper({
  index,
  activeTerminal,
  isReload,
  shouldRunWorkerBuild,
}: {
  index: number;
  activeTerminal: number;
  isReload?: boolean;
  shouldRunWorkerBuild?: boolean;
}) {
  const theme = useStore(themeStore);

  const onTerminalReady = useCallback(
    (terminal: XTerm) => {
      if (index === APP_SHELL_TAB_INDEX) {
        workbenchStore.attachAppShellTerminal(terminal);
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
    [index, isReload, shouldRunWorkerBuild],
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
    />
  );
}
