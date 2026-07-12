import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';
import { memo, useEffect, useRef } from 'react';
import type { Theme } from '~/lib/stores/theme';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { getTerminalTheme } from './theme';

import '@xterm/xterm/css/xterm.css';

const logger = createScopedLogger('Terminal');

export const Terminal = memo(function Terminal({
  className,
  theme,
  readonly,
  visible,
  id,
  onTerminalReady,
  onTerminalResize,
}: {
  className?: string;
  theme: Theme;
  readonly?: boolean;
  visible: boolean;
  id: string;
  onTerminalReady?: (terminal: XTerm) => void;
  onTerminalResize?: (cols: number, rows: number) => void;
}) {
  const terminalElementRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const element = terminalElementRef.current;
    if (!element) {
      return undefined;
    }

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      disableStdin: readonly,
      theme: getTerminalTheme(readonly ? { cursor: '#00000000' } : {}),
      fontSize: 12,
      fontFamily: 'Menlo, courier-new, courier, monospace',
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(element);

    logger.debug(`Attach [${id}]`);

    onTerminalReady?.(terminal);

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [id, onTerminalReady, onTerminalResize, readonly]);

  useEffect(() => {
    const element = terminalElementRef.current;
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!visible || !element || !terminal || !fitAddon) {
      return undefined;
    }

    let animationFrame: number | undefined;
    let lastColumns = -1;
    let lastRows = -1;

    const fit = () => {
      animationFrame = undefined;
      const { width, height } = element.getBoundingClientRect();
      if (width <= 0 || height <= 0) {
        return;
      }
      fitAddon.fit();
      if (terminal.cols === lastColumns && terminal.rows === lastRows) {
        return;
      }
      lastColumns = terminal.cols;
      lastRows = terminal.rows;
      onTerminalResize?.(terminal.cols, terminal.rows);
    };
    const scheduleFit = () => {
      if (animationFrame === undefined) {
        animationFrame = requestAnimationFrame(fit);
      }
    };
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(element);
    scheduleFit();

    return () => {
      resizeObserver.disconnect();
      if (animationFrame !== undefined) {
        cancelAnimationFrame(animationFrame);
      }
    };
  }, [visible, onTerminalResize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    // we render a transparent cursor in case the terminal is readonly
    terminal.options.theme = getTerminalTheme(readonly ? { cursor: '#00000000' } : {});

    terminal.options.disableStdin = readonly;
  }, [theme, readonly]);

  return <div className={className} ref={terminalElementRef} />;
});
