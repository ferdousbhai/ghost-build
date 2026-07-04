import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import type { ITerminal } from '~/types/terminal';
import { withResolvers } from './promises';
import { ContainerBootState, waitForContainerBootState } from '~/lib/stores/containerBootState';
import { cleanTerminalOutput } from 'ghostbuild-agent/utils/shell';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import {
  assertProductionShellCommandAllowed,
  findForbiddenProductionShellCommand,
} from '~/utils/productionShellPolicy';

const logger = createScopedLogger('Shell');

type InteractiveJshProcess = {
  process: WebContainerProcess;
  input: WritableStreamDefaultWriter<string>;
  output: ReadableStream<string>;
};

async function spawnInteractiveJsh(webcontainer: WebContainer, terminal: ITerminal): Promise<InteractiveJshProcess> {
  // Wait for setup to fully complete before allowing shells to spawn.
  await waitForContainerBootState(ContainerBootState.READY);

  // we spawn a JSH process with a fallback cols and rows in case the process is not attached yet to a visible terminal
  const process = await webcontainer.spawn('/bin/jsh', ['--osc'], {
    terminal: {
      cols: terminal.cols ?? 80,
      rows: terminal.rows ?? 15,
    },
  });

  return {
    process,
    input: process.input.getWriter(),
    output: process.output,
  };
}

function wireInteractiveTerminal({
  input,
  output,
  terminal,
}: Pick<InteractiveJshProcess, 'input' | 'output'> & { terminal: ITerminal }) {
  const jshReady = withResolvers<void>();
  const guardedInput = createProductionShellInputGuard(input, terminal);
  let isInteractive = false;

  void output.pipeTo(
    new WritableStream({
      write(data) {
        if (!isInteractive) {
          const [, osc] = data.match(/\x1b\]654;([^\x07]+)\x07/) || [];

          if (osc === 'interactive') {
            isInteractive = true;
            jshReady.resolve();
          }
        }

        terminal.write(data);
      },
    }),
  );

  terminal.onData((data) => {
    if (isInteractive) {
      guardedInput(data);
    }
  });

  return jshReady.promise;
}

function createProductionShellInputGuard(input: WritableStreamDefaultWriter<string>, terminal: ITerminal) {
  let commandBuffer = '';

  const resetCommandBuffer = () => {
    commandBuffer = '';
  };

  const writeBlockedCommandMessage = (reason: string) => {
    terminal.write(
      `\r\nLocal dev-server and staging commands are disabled for Ghostbuild projects: ${reason}. Deploy directly to the production Cloudflare Worker with pnpm run deploy.\r\n`,
    );
  };

  const forwardCharacter = (character: string) => {
    if (character === '\x03') {
      resetCommandBuffer();
      void input.write(character);
      return;
    }

    if (character === '\x15') {
      resetCommandBuffer();
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
      resetCommandBuffer();

      if (forbiddenCommand) {
        void input.write('\x03');
        writeBlockedCommandMessage(forbiddenCommand.reason);
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

  return (data: string) => {
    if (data.startsWith('\x1b')) {
      void input.write(data);
      return;
    }

    for (const character of data) {
      forwardCharacter(character);
    }
  };
}

export async function newShellProcess(webcontainer: WebContainer, terminal: ITerminal) {
  const { process, input, output } = await spawnInteractiveJsh(webcontainer, terminal);
  await wireInteractiveTerminal({ input, output, terminal });

  return process;
}

type ExecutionResult = { output: string; exitCode: number };

class GhostbuildShell {
  #initialized: (() => void) | undefined;
  #readyPromise: Promise<void>;
  #webcontainer: WebContainer | undefined;
  #terminal: ITerminal | undefined;
  #process: WebContainerProcess | undefined;
  #outputStream: ReadableStreamDefaultReader<string> | undefined;
  #shellInputStream: WritableStreamDefaultWriter<string> | undefined;

  constructor() {
    this.#readyPromise = new Promise((resolve) => {
      this.#initialized = resolve;
    });
  }

  ready() {
    return this.#readyPromise;
  }

  async init(webcontainer: WebContainer, terminal: ITerminal) {
    this.#webcontainer = webcontainer;
    this.#terminal = terminal;

    const { process, output } = await this.newGhostbuildShellProcess(webcontainer, terminal);
    this.#process = process;
    this.#outputStream = output.getReader();
    await this.waitTillOscCode('interactive');
    this.#initialized?.();
  }

  get terminal() {
    return this.#terminal;
  }

  get process() {
    return this.#process;
  }

  async startCommand(command: string) {
    if (!this.process || !this.terminal) {
      throw new Error('Terminal not initialized');
    }

    assertProductionShellCommandAllowed(command);

    // For terminals that might be readonly, use write method directly for sending commands
    const shellInput = this.#shellInputStream;
    if (!shellInput) {
      throw new Error('Shell input stream not initialized');
    }

    // Interrupt the current execution with Ctrl+C
    void shellInput.write('\x03');
    await this.waitTillOscCode('prompt');

    void shellInput.write(command.trim() + '\n');
  }

  async executeCommand(command: string): Promise<ExecutionResult> {
    await this.startCommand(command);

    // Wait for the execution to finish
    const { output, exitCode } = await this.waitTillOscCode('exit');

    let cleanedOutput = output;
    try {
      cleanedOutput = cleanTerminalOutput(output);
    } catch (error) {
      logger.debug('Failed to format terminal output', error);
    }

    return { output: cleanedOutput, exitCode };
  }

  async newGhostbuildShellProcess(webcontainer: WebContainer, terminal: ITerminal) {
    const { process, input, output } = await spawnInteractiveJsh(webcontainer, terminal);
    this.#shellInputStream = input;

    const [internalOutput, terminalOutput] = output.tee();
    await wireInteractiveTerminal({ input, output: terminalOutput, terminal });

    return { process, output: internalOutput };
  }

  async waitTillOscCode(waitCode: string) {
    let fullOutput = '';
    let exitCode: number = 0;

    if (!this.#outputStream) {
      return { output: fullOutput, exitCode };
    }

    const tappedStream = this.#outputStream;

    while (true) {
      const { value, done } = await tappedStream.read();

      if (done) {
        break;
      }

      const text = value || '';
      fullOutput += text;

      // Check if command completion signal with exit code
      const [, osc, , , code] = text.match(/\x1b\]654;([^\x07=]+)=?((-?\d+):(\d+))?\x07/) || [];

      if (osc === 'exit') {
        exitCode = parseInt(code, 10);
      }

      if (osc === waitCode) {
        break;
      }
    }

    return { output: fullOutput, exitCode };
  }
}

export function newGhostbuildShellProcess() {
  return new GhostbuildShell();
}
