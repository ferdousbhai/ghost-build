import { useStore } from '@nanostores/react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { memo, useEffect, useRef } from 'react';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import type { ArtifactState } from '~/lib/stores/workbench-artifacts';
import { themeStore } from '~/lib/stores/theme';
import { getTerminalTheme } from '~/components/workbench/terminal/theme';

import '@xterm/xterm/css/xterm.css';
import { toolResultSummary } from 'ghostbuild-agent/tool-result';

export const ToolOutputTerminal = memo(function ToolOutputTerminal({
  artifact,
  invocation,
}: {
  artifact: ArtifactState;
  invocation: GhostbuildToolInvocation;
}) {
  const theme = useStore(themeStore);
  let terminalOutput = useStore(artifact.runner.terminalOutput);

  if (!terminalOutput && invocation.state === 'result') {
    terminalOutput = toolResultSummary(invocation.result);
  }

  const terminalElementRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);

  useEffect(() => {
    const element = terminalElementRef.current;
    if (!element) {
      return undefined;
    }

    const fitAddon = new FitAddon();
    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      disableStdin: true,
      theme: getTerminalTheme({ cursor: '#00000000' }),
      fontSize: 12,
      fontFamily: 'Menlo, courier-new, courier, monospace',
    });

    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    terminal.open(element);

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
    };
  }, []);

  const written = useRef(0);

  useEffect(() => {
    if (terminalRef.current && terminalOutput.length > written.current) {
      terminalRef.current.write(terminalOutput.slice(written.current));
      written.current = terminalOutput.length;
    }
  }, [terminalOutput]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.theme = getTerminalTheme({ cursor: '#00000000' });
    terminal.options.disableStdin = true;
  }, [theme]);

  return (
    <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-terminals-background font-mono text-sm">
      <div className="h-40" ref={terminalElementRef} />
    </div>
  );
});
