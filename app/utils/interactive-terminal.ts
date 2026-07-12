import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { ContainerBootState, waitForContainerBootState } from '~/lib/stores/containerBootState';
import type { ITerminal } from '~/types/terminal';
import { findForbiddenProductionShellCommand } from '~/utils/productionShellPolicy';
import { withResolvers } from './promises';

export interface InteractiveJshProcess {
  process: WebContainerProcess;
  input: WritableStreamDefaultWriter<string>;
  output: ReadableStream<string>;
}

export async function spawnInteractiveJsh(
  webcontainer: WebContainer,
  terminal: ITerminal,
): Promise<InteractiveJshProcess> {
  await waitForContainerBootState(ContainerBootState.READY);
  const process = await webcontainer.spawn('/bin/jsh', ['--osc'], {
    terminal: { cols: terminal.cols ?? 80, rows: terminal.rows ?? 15 },
  });
  return { process, input: process.input.getWriter(), output: process.output };
}

export function wireInteractiveTerminal({
  input,
  output,
  terminal,
}: Pick<InteractiveJshProcess, 'input' | 'output'> & { terminal: ITerminal }): Promise<void> {
  const ready = withResolvers<void>();
  const guardedInput = createProductionShellInputGuard(input, terminal);
  let isInteractive = false;
  void output
    .pipeTo(
      new WritableStream({
        write(data) {
          if (!isInteractive) {
            const [, osc] = data.match(/\x1b\]654;([^\x07]+)\x07/) || [];
            if (osc === 'interactive') {
              isInteractive = true;
              ready.resolve();
            }
          }
          terminal.write(data);
        },
      }),
    )
    .catch(ready.reject);
  terminal.onData((data) => {
    if (isInteractive) {
      guardedInput(data);
    }
  });
  return ready.promise;
}

export async function newShellProcess(webcontainer: WebContainer, terminal: ITerminal): Promise<WebContainerProcess> {
  const { process, input, output } = await spawnInteractiveJsh(webcontainer, terminal);
  await wireInteractiveTerminal({ input, output, terminal });
  return process;
}

function createProductionShellInputGuard(
  input: WritableStreamDefaultWriter<string>,
  terminal: ITerminal,
): (data: string) => void {
  let commandBuffer = '';
  const forwardCharacter = (character: string) => {
    if (character === '\x03' || character === '\x15') {
      commandBuffer = '';
      void input.write(character);
      return;
    }
    if (character === '\x7f') {
      commandBuffer = commandBuffer.slice(0, -1);
      void input.write(character);
      return;
    }
    if (character === '\r' || character === '\n') {
      const forbiddenCommand = findForbiddenProductionShellCommand(commandBuffer);
      commandBuffer = '';
      if (forbiddenCommand) {
        void input.write('\x03');
        terminal.write(
          `\r\nLocal dev-server and staging commands are disabled for Ghostbuild projects: ${forbiddenCommand.reason}. Deploy directly to the production Cloudflare Worker with pnpm run deploy.\r\n`,
        );
        return;
      }
      void input.write(character);
      return;
    }
    if (/^[\x20-\x7e]$/.test(character)) {
      commandBuffer += character;
    }
    void input.write(character);
  };

  return (data) => {
    if (data.startsWith('\x1b')) {
      void input.write(data);
      return;
    }
    for (const character of data) {
      forwardCharacter(character);
    }
  };
}
